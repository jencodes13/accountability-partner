"""
Voice Check-In Sessions — WebSocket endpoint.
Browser <-> FastAPI (WebSocket) <-> Gemini Live

Flow:
1. Client connects via WebSocket with userId
2. Server loads user context from Firestore
3. Server builds dynamic system prompt with all user data
4. Audio streams bidirectionally: client <-> server <-> Gemini Live
5. All transcripts (user + agent) collected for review/tuning
6. On disconnect, structured data extracted from transcript via regular Gemini call
7. Full transcript is persisted to the session doc
"""

import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

from agent.prompt_builder import build_system_prompt
from services.firestore_service import (
    get_user_profile,
    get_habits,
    get_recent_photos,
    get_checkin_sessions,
    save_checkin_session,
    update_streak,
)

logger = logging.getLogger(__name__)

router = APIRouter()

GEMINI_MODEL = "gemini-2.5-flash-native-audio-latest"

# Map persona to Gemini voice preset
PERSONA_VOICES = {
    "coach": "Kore",       # More assertive/direct
    "friend": "Zephyr",    # Warm/casual
    "reflective": "Puck",  # Calm/thoughtful
}


# ─── Extraction prompt for post-session structured data extraction ───

SESSION_EXTRACTION_PROMPT_TEMPLATE = """Extract the following from this check-in conversation transcript. The user's active habits are listed below — use their exact habit IDs when referencing which habits were discussed.

Active habits:
{habits_info}

Return ONLY valid JSON, nothing else.

{{
  "summary": "A 2-3 sentence natural summary of the check-in session",
  "habits_covered": ["list of habit IDs that were actually discussed"],
  "micro_commitment": "the specific micro-commitment the user made, or empty string if none",
  "patterns_flagged": ["list of pattern observations, empty array if none"],
  "streak_updates": {{"habitId": "maintained or broken or unknown"}}
}}

For streak_updates: "maintained" means the user reported keeping up the habit, "broken" means they reported missing it or slipping, "unknown" if the status wasn't clear.

Transcript:
{transcript_text}"""


@router.websocket("/{user_id}")
async def voice_session(ws: WebSocket, user_id: str):
    await ws.accept()

    # Collect full transcript for persistence
    transcript: list[dict] = []

    try:
        # 1. Load user context
        profile = await get_user_profile(user_id)
        if not profile:
            await ws.send_json({"type": "error", "message": "User not found"})
            await ws.close()
            return

        habits = get_habits(user_id)
        recent_sessions = get_checkin_sessions(user_id, limit_count=10)
        last_session = recent_sessions[0] if recent_sessions else None

        # Get photos since last check-in
        last_checkin_time = None
        if last_session and last_session.get("timestamp"):
            last_checkin_time = last_session["timestamp"]
        recent_photos = get_recent_photos(user_id, since=last_checkin_time)

        # 2. Build system prompt
        system_prompt = build_system_prompt(
            profile=profile,
            habits=habits,
            recent_photos=recent_photos,
            last_session=last_session,
            sessions=recent_sessions,
        )

        # 3. Select voice — user's explicit choice first, then persona fallback
        persona = profile.get("persona", "friend")
        voice_name = profile.get("voiceName")
        if not voice_name:
            voice_name = PERSONA_VOICES.get(persona, "Zephyr")

        # 4. Connect to Gemini Live
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
                )
            ),
            system_instruction=system_prompt,
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=False,
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                    prefix_padding_ms=20,
                    silence_duration_ms=400,
                )
            ),
        )

        async with client.aio.live.connect(model=GEMINI_MODEL, config=config) as session:
            await ws.send_json({"type": "connected", "voice": voice_name, "persona": persona})

            # 5. Bidirectional streaming
            audio_chunk_count = 0

            async def forward_client_to_gemini():
                """Receive audio from browser, forward to Gemini."""
                nonlocal audio_chunk_count
                try:
                    while True:
                        data = await ws.receive_text()
                        msg = json.loads(data)

                        if msg["type"] == "audio":
                            audio_bytes = base64.b64decode(msg["data"])
                            audio_chunk_count += 1
                            if audio_chunk_count <= 3 or audio_chunk_count % 50 == 0:
                                print(f"[SESSION] >> Audio chunk #{audio_chunk_count} ({len(audio_bytes)} bytes)")
                            try:
                                await session.send_realtime_input(
                                    audio=types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                                )
                            except Exception as e:
                                print(f"[SESSION] !! Failed to send audio: {e}")
                                break
                        elif msg["type"] == "speech_start":
                            print("[SESSION] >> speech_start (push-to-talk)")
                            try:
                                await session.send_realtime_input(activity_start=types.ActivityStart())
                            except Exception as e:
                                print(f"[SESSION] !! Failed to send activity_start: {e}")
                        elif msg["type"] == "speech_end":
                            print("[SESSION] >> speech_end (push-to-talk)")
                            try:
                                await session.send_realtime_input(activity_end=types.ActivityEnd())
                            except Exception as e:
                                print(f"[SESSION] !! Failed to send activity_end: {e}")
                        elif msg["type"] == "photo":
                            print("[SESSION] >> Photo received, analyzing with ADK agent...")
                            try:
                                from google.adk.runners import InMemoryRunner
                                from google.genai import types as genai_types
                                from agent.photo_agent import photo_analysis_agent

                                # Create a runner for the photo analysis
                                runner = InMemoryRunner(
                                    agent=photo_analysis_agent,
                                    app_name="photo_analyzer",
                                )

                                # Create a session
                                session_service = runner.session_service
                                photo_session = session_service.create_session(
                                    app_name="photo_analyzer",
                                    user_id=user_id,
                                )

                                # Decode the photo
                                photo_bytes = base64.b64decode(msg["data"].split(",")[-1])

                                # Run the agent with the photo
                                content = genai_types.Content(
                                    role="user",
                                    parts=[
                                        genai_types.Part(text="What do you see in this photo?"),
                                        genai_types.Part(inline_data=genai_types.Blob(data=photo_bytes, mime_type="image/jpeg")),
                                    ]
                                )

                                description = ""
                                async for event in runner.run_async(
                                    session_id=photo_session.id,
                                    user_id=user_id,
                                    new_message=content,
                                ):
                                    if event.content and event.content.parts:
                                        for part in event.content.parts:
                                            if part.text:
                                                description += part.text

                                description = description.strip()
                                print(f"[SESSION] ADK photo description: {description}")

                                # Inject into the live conversation
                                await session.send_realtime_input(
                                    text=f"The user just showed you a photo. Here's what's in it: {description}. Respond naturally — comment on what you see and connect it to their habits."
                                )
                            except Exception as e:
                                print(f"[SESSION] !! Photo analysis failed: {e}")
                                import traceback
                                traceback.print_exc()
                                await session.send_realtime_input(
                                    text="The user tried to share a photo but there was a technical issue. Let them know and continue the check-in."
                                )
                        elif msg["type"] == "audio_end":
                            print("[SESSION] >> audio_stream_end (silence detected)")
                            try:
                                await session.send_realtime_input(audio_stream_end=True)
                            except Exception as e:
                                print(f"[SESSION] !! Failed to send audio_stream_end: {e}")
                        elif msg["type"] == "end":
                            logger.info(">> Client sent 'end' signal")
                            break
                except WebSocketDisconnect:
                    logger.info(">> Client WebSocket disconnected")
                except Exception as e:
                    logger.error("Client->Gemini forward error: %s", e)

            async def forward_gemini_to_client():
                """Receive audio from Gemini, forward to browser."""
                gemini_msg_count = 0
                try:
                    while True:
                        print(f"[SESSION] Waiting for Gemini (msgs so far: {gemini_msg_count})")
                        async for message in session.receive():
                            gemini_msg_count += 1
                            sc = getattr(message, "server_content", None)
                            ha = bool(sc and getattr(sc, "model_turn", None) and sc.model_turn.parts and any(p.inline_data and p.inline_data.data for p in sc.model_turn.parts))
                            tc = bool(sc and getattr(sc, "turn_complete", False))
                            if gemini_msg_count <= 10 or gemini_msg_count % 20 == 0 or tc:
                                print(f"[SESSION] << msg #{gemini_msg_count}: audio={ha} turn_complete={tc}")

                            if tc:
                                await ws.send_json({"type": "turn_complete"})

                            if not sc:
                                continue
                            if sc.interrupted:
                                await ws.send_json({"type": "interrupted"})
                                continue

                            model_turn = getattr(sc, "model_turn", None)
                            if model_turn and model_turn.parts:
                                for part in model_turn.parts:
                                    if part.inline_data and part.inline_data.data:
                                        await ws.send_json({"type": "audio", "data": base64.b64encode(part.inline_data.data).decode()})
                                    if part.text:
                                        transcript.append({"role": "agent", "text": part.text, "source": "model_turn", "timestamp": datetime.now(timezone.utc).isoformat()})
                                        if not part.text.strip().startswith("**"):
                                            await ws.send_json({"type": "transcript", "role": "assistant", "text": part.text})

                            input_tx = getattr(sc, "input_transcription", None)
                            if input_tx and input_tx.text:
                                transcript.append({"role": "user", "text": input_tx.text, "source": "input_transcription", "timestamp": datetime.now(timezone.utc).isoformat()})
                                await ws.send_json({"type": "transcript", "role": "user", "text": input_tx.text})

                            output_tx = getattr(sc, "output_transcription", None)
                            if output_tx and output_tx.text:
                                transcript.append({"role": "agent", "text": output_tx.text, "source": "output_transcription", "timestamp": datetime.now(timezone.utc).isoformat()})
                                if not output_tx.text.strip().startswith("**"):
                                    await ws.send_json({"type": "transcript", "role": "assistant", "text": output_tx.text})

                        print(f"[SESSION] receive() ended after {gemini_msg_count} msgs — looping for next turn")
                except WebSocketDisconnect:
                    print("[SESSION] Client disconnected")
                except Exception as e:
                    print(f"[SESSION] !! Receive error: {e}")
                    try:
                        await ws.send_json({"type": "error", "message": str(e)})
                    except Exception:
                        pass

            # Trigger greeting
            user_name = profile.get("displayName", "there")
            print(f"[SESSION] Sending greeting for {user_name}...")
            await session.send(input=f"The user {user_name} just connected for a check-in. Greet them and start the session.", end_of_turn=True)
            print("[SESSION] Greeting sent!")

            # Run both directions concurrently
            await asyncio.gather(
                forward_client_to_gemini(),
                forward_gemini_to_client(),
            )

        await ws.send_json({"type": "session_ended"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Session WebSocket error: %s", e)
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        # Extract structured data from transcript and persist
        if transcript:
            try:
                extraction_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

                transcript_text = "\n".join([
                    f"{t['role']}: {t['text']}"
                    for t in transcript
                    if t.get('text') and t['role'] in ('user', 'agent')
                ])

                # Build habits info for the extraction prompt
                habits_info = "\n".join([
                    f"- ID: {h.get('id', '')}, Category: {h.get('category', '')}, Goal: {h.get('label', '')}"
                    for h in habits
                ])

                extraction_prompt = SESSION_EXTRACTION_PROMPT_TEMPLATE.format(
                    habits_info=habits_info,
                    transcript_text=transcript_text,
                )

                print(f"[SESSION] Extracting structured data from transcript ({len(transcript)} entries)...")
                extraction_response = extraction_client.models.generate_content(
                    model="gemini-2.0-flash",
                    contents=extraction_prompt,
                )

                # Clean the response — strip markdown code fences if present
                response_text = extraction_response.text.strip()
                if response_text.startswith('```'):
                    response_text = response_text.split('\n', 1)[1]
                    response_text = response_text.rsplit('```', 1)[0]

                extracted = json.loads(response_text)

                habits_covered = extracted.get("habits_covered", [])
                patterns_flagged = extracted.get("patterns_flagged", [])
                streak_updates = extracted.get("streak_updates", {})

                saved_session_id = save_checkin_session(user_id, {
                    "summary": extracted.get("summary", ""),
                    "habitsCovered": habits_covered,
                    "microCommitment": extracted.get("micro_commitment", ""),
                    "patternsFlagged": patterns_flagged,
                    "streakUpdates": streak_updates,
                    "transcript": transcript,
                })

                for habit_id, outcome in streak_updates.items():
                    update_streak(user_id, habit_id, outcome)

                print(f"[SESSION] Saved from transcript: {len(habits_covered)} habits, session={saved_session_id}")

                # Notify frontend with session summary
                try:
                    await ws.send_json({
                        "type": "session_summary",
                        "sessionId": saved_session_id,
                        "habitsCovered": habits_covered,
                        "habitsSkipped": [h["id"] for h in habits if h.get("id") not in habits_covered],
                        "commitments": [extracted.get("micro_commitment", "")],
                        "insight": extracted.get("summary", ""),
                        "streaks": streak_updates,
                    })
                except Exception:
                    pass  # WebSocket might already be closed

            except Exception as e:
                print(f"[SESSION] !! Transcript extraction failed: {e}")
                import traceback
                traceback.print_exc()
                # Fall back: save transcript without structured data
                try:
                    save_checkin_session(user_id, {
                        "summary": "Session ended before summary was generated",
                        "transcript": transcript,
                    })
                except Exception as e2:
                    logger.error("Failed to save fallback check-in transcript for %s: %s", user_id, e2)

            logger.info("Saved check-in transcript for user %s (%d entries)", user_id, len(transcript))

        try:
            await ws.close()
        except Exception:
            pass
