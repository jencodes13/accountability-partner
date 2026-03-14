"""
Voice Check-In Sessions — WebSocket endpoint.
Browser <-> FastAPI (WebSocket) <-> Gemini Live

Flow:
1. Client connects via WebSocket with userId
2. Server loads user context from Firestore
3. Server builds dynamic system prompt with all user data
4. Audio streams bidirectionally: client <-> server <-> Gemini Live
5. All transcripts (user + agent) collected for review/tuning
6. Agent can call tools mid-conversation (save summary, update streaks)
7. On disconnect, full transcript is persisted to the session doc
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
    save_session_transcript,
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

# ─── Tool definitions for check-in sessions ───

SESSION_TOOLS = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="save_checkin_summary",
            description=(
                "Save the check-in session summary. Call this at the end of every session "
                "after the closing ritual (identity anchor + micro-commitment). Include a "
                "natural summary of what was discussed, which habits were covered, the "
                "user's micro-commitment, any patterns you noticed, and streak updates."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "summary": types.Schema(
                        type="STRING",
                        description="A 2-3 sentence natural summary of the check-in session",
                    ),
                    "habits_covered": types.Schema(
                        type="STRING",
                        description="Comma-separated habit IDs that were discussed",
                    ),
                    "micro_commitment": types.Schema(
                        type="STRING",
                        description="The specific micro-commitment the user made",
                    ),
                    "patterns_flagged": types.Schema(
                        type="STRING",
                        description="Comma-separated pattern observations (empty if none)",
                    ),
                    "streak_updates": types.Schema(
                        type="STRING",
                        description=(
                            "JSON string of habit streak updates. Format: "
                            '{\"habitId1\": \"maintained\", \"habitId2\": \"broken\"} '
                            "Values: maintained (continued), broken (reset), unknown (no change)"
                        ),
                    ),
                },
                required=["summary", "micro_commitment"],
            ),
        ),
    ]
)


@router.websocket("/{user_id}")
async def voice_session(ws: WebSocket, user_id: str):
    await ws.accept()

    # Collect full transcript for persistence
    transcript: list[dict] = []
    saved_session_id: str | None = None

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

        # 3. Select voice based on persona
        persona = profile.get("persona", "friend")
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
            tools=[SESSION_TOOLS],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
        )

        async with client.aio.live.connect(model=GEMINI_MODEL, config=config) as session:
            await ws.send_json({"type": "connected", "voice": voice_name, "persona": persona})

            # Prompt the model to start the check-in conversation
            user_name = profile.get("displayName", "there")
            await session.send(input=f"The user {user_name} just connected for a check-in. Greet them and start the session.", end_of_turn=True)

            # 5. Bidirectional streaming
            async def forward_client_to_gemini():
                """Receive audio from browser, forward to Gemini."""
                try:
                    while True:
                        data = await ws.receive_text()
                        msg = json.loads(data)

                        if msg["type"] == "audio":
                            audio_bytes = base64.b64decode(msg["data"])
                            await session.send_realtime_input(
                                audio=types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                            )
                        elif msg["type"] == "end":
                            break
                except WebSocketDisconnect:
                    pass

            async def forward_gemini_to_client():
                """Receive audio/tool calls from Gemini, forward to browser."""
                nonlocal saved_session_id

                try:
                    async for message in session.receive():
                        # Handle tool calls
                        tool_call = getattr(message, "tool_call", None)
                        if tool_call and tool_call.function_calls:
                            for fc in tool_call.function_calls:
                                await ws.send_json({
                                    "type": "tool_activity",
                                    "tool": fc.name,
                                })

                                if fc.name == "save_checkin_summary":
                                    args = fc.args or {}

                                    # Record tool call in transcript
                                    transcript.append({
                                        "role": "tool_call",
                                        "tool": fc.name,
                                        "args": args,
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                    })

                                    # Parse comma-separated lists
                                    habits_str = args.get("habits_covered", "")
                                    habits_covered = [h.strip() for h in habits_str.split(",") if h.strip()]

                                    patterns_str = args.get("patterns_flagged", "")
                                    patterns_flagged = [p.strip() for p in patterns_str.split(",") if p.strip()]

                                    # Parse streak updates JSON
                                    streak_updates = {}
                                    streak_str = args.get("streak_updates", "{}")
                                    try:
                                        streak_updates = json.loads(streak_str) if streak_str else {}
                                    except json.JSONDecodeError:
                                        logger.warning("Failed to parse streak_updates: %s", streak_str)

                                    # Save to Firestore (transcript appended in finally block)
                                    saved_session_id = save_checkin_session(user_id, {
                                        "summary": args.get("summary", ""),
                                        "habitsCovered": habits_covered,
                                        "microCommitment": args.get("micro_commitment", ""),
                                        "patternsFlagged": patterns_flagged,
                                        "streakUpdates": streak_updates,
                                    })

                                    # Update streaks
                                    for habit_id, outcome in streak_updates.items():
                                        update_streak(user_id, habit_id, outcome)

                                    # Respond to tool call
                                    await session.send(
                                        input=types.LiveClientToolResponse(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=fc.id,
                                                    name=fc.name,
                                                    response={"status": "saved", "sessionId": saved_session_id},
                                                )
                                            ]
                                        )
                                    )

                                    # Send session_summary for frontend UI
                                    await ws.send_json({
                                        "type": "session_summary",
                                        "sessionId": saved_session_id,
                                        "habitsCovered": habits_covered,
                                        "habitsSkipped": [
                                            h["id"] for h in habits
                                            if h.get("id") not in habits_covered
                                        ],
                                        "commitments": [args.get("micro_commitment", "")],
                                        "insight": args.get("summary", ""),
                                        "streaks": streak_updates,
                                    })
                            continue

                        server_content = getattr(message, "server_content", None)
                        if not server_content:
                            continue

                        # Handle interruption
                        if server_content.interrupted:
                            await ws.send_json({"type": "interrupted"})
                            continue

                        # Forward audio and collect text transcript
                        model_turn = getattr(server_content, "model_turn", None)
                        if model_turn and model_turn.parts:
                            for part in model_turn.parts:
                                if part.inline_data and part.inline_data.data:
                                    audio_b64 = base64.b64encode(part.inline_data.data).decode()
                                    await ws.send_json({
                                        "type": "audio",
                                        "data": audio_b64,
                                    })
                                if part.text:
                                    # Always record to transcript (including thinking text)
                                    transcript.append({
                                        "role": "agent",
                                        "text": part.text,
                                        "source": "model_turn",
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                    })
                                    # Only forward non-thinking text to frontend
                                    if not part.text.strip().startswith("**"):
                                        await ws.send_json({
                                            "type": "transcript",
                                            "role": "assistant",
                                            "text": part.text,
                                        })

                        # Handle transcriptions — always record, selectively forward
                        input_tx = getattr(server_content, "input_transcription", None)
                        if input_tx and input_tx.text:
                            transcript.append({
                                "role": "user",
                                "text": input_tx.text,
                                "source": "input_transcription",
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                            })
                            await ws.send_json({
                                "type": "transcript",
                                "role": "user",
                                "text": input_tx.text,
                            })

                        output_tx = getattr(server_content, "output_transcription", None)
                        if output_tx and output_tx.text:
                            text = output_tx.text
                            # Always record to transcript
                            transcript.append({
                                "role": "agent",
                                "text": text,
                                "source": "output_transcription",
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                            })
                            # Only forward non-thinking text to frontend
                            if not text.strip().startswith("**"):
                                await ws.send_json({
                                    "type": "transcript",
                                    "role": "assistant",
                                    "text": text,
                                })

                except Exception as e:
                    logger.error("Gemini receive error: %s", e)
                    await ws.send_json({"type": "error", "message": str(e)})

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
        # Persist transcript to the session document
        if transcript:
            try:
                if saved_session_id:
                    # Tool call already created the session doc — append transcript
                    save_session_transcript(user_id, saved_session_id, transcript)
                else:
                    # No tool call happened (e.g. early disconnect) — save as standalone
                    save_checkin_session(user_id, {
                        "summary": "Session ended before summary was generated",
                        "transcript": transcript,
                    })
                logger.info("Saved check-in transcript for user %s (%d entries)", user_id, len(transcript))
            except Exception as e:
                logger.error("Failed to save check-in transcript for %s: %s", user_id, e)
        try:
            await ws.close()
        except Exception:
            pass
