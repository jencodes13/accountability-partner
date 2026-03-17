"""
Onboarding API — voice onboarding via Gemini Live + REST save endpoint.

WebSocket flow:
1. Client connects with userId
2. Gemini Live guides the user through onboarding via voice
3. All transcripts (user + agent) are collected
4. When the session ends, a separate Gemini call extracts structured data from transcript
5. Server saves extracted data to Firestore and sends onboarding_complete to client
6. Client shows review form → user edits → POST saves to Firestore
"""

import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from google import genai
from google.genai import types

from services.firestore_service import complete_onboarding, get_user_profile, save_onboarding_session

logger = logging.getLogger(__name__)

router = APIRouter()

GEMINI_MODEL = "gemini-2.5-flash-native-audio-latest"

# ─── Onboarding system prompt ───

ONBOARDING_PROMPT = """You are a warm, friendly onboarding guide for an accountability partner app. \
Your job is to have a short, natural voice conversation to learn about the user and set up their \
accountability partner. Keep it brisk — 3 to 4 minutes max.

You are collecting this information through natural conversation (DO NOT mention this schema):
- Their name
- Up to 3 habits they want to track (categories: alcohol, sports-betting, nutrition, exercise, \
spending, journaling, screen-time, sleep, workouts-steps)
- A short goal label for each habit
- Their preferred coaching style: coach (direct), friend (encouraging), or reflective (curious)
- Whether they prefer a masculine or feminine voice for check-ins
- What they want to call their accountability partner

OPENING: Start with exactly this: "Hey, it's great to meet you. I'm here to be your \
accountability partner. What's your name?" Wait for them to respond with their name. \
Then say: "Great to meet you, [name]. I can help with things like exercise, nutrition, \
spending, screen time, sleep, journaling, betting, or alcohol consumption. What resonates \
with you?"

PACING: You must ask one question at a time and WAIT for the user to respond before continuing. \
Do NOT gather multiple pieces of information from a single response and assume you have everything.

CONVERSATION ARC — follow this order:

1. HABITS (up to 3): After offering the categories, let the user pick. Confirm what you heard. \
Ask "anything else you want to work on?" If they say no or indicate they're done \
with fewer than 3, that's fine — say something like "Great start! We can always add more \
habits later." If they try to add more than 3, let them know: "I can only track up to 3 \
habits right now, but we're working on supporting more in the future. Which 3 matter most \
to you?" Do NOT ask per-habit \
goals — for most habits the goal is obvious (sleep more, eat better, journal consistently, \
spend less). Only ask for clarification if the habit is genuinely ambiguous, like spending \
("Are you looking to budget overall, or cut back on something specific?"). \
IMPORTANT: Only accept answers that match or relate to the offered categories. If someone \
says something random like "cheese" or "purple" when you ask about habits, that is NOT a \
valid habit — say "Ha, not sure I have a category for that one! Let me ask again — which \
of those areas would you like to focus on?" and re-offer the list. \
Do NOT ask clarifying questions for straightforward habits. Exercise, nutrition, sleep, \
journaling, screen time, alcohol consumption, and betting are all self-explanatory — just \
confirm and move on. ONLY ask for clarification on spending (budget vs. specific cutback).

2. GET TO KNOW THEM: Ask: "What made you want to start working on these right now?" \
This is about motivation and life context — not obstacles. Let them share. Whatever they \
say helps the check-in agent personalize future conversations. Do NOT ask about obstacles \
or what gets in the way — that's for the check-ins to uncover over time.

3. STYLE: "When things get tough with your habits, do you want someone who's direct with you, \
someone encouraging, or someone who asks questions and lets you figure it out?" Map their \
answer: direct = coach, encouraging = friend, questions = reflective.

4. VOICE: "One more thing — would you prefer a masculine or feminine voice for our \
check-ins?" Just note their answer.

5. AGENT NAME: "And what do you want to call me? Pick whatever feels right." \
When they give a name, REPEAT IT BACK to confirm: "Alright, [agent name] it is!"

6. WRAP UP: Say your full closing message. Include a brief, warm note that this app is \
a great tool to help with accountability, but it's not a replacement for professional \
support — something natural like "And just so you know, I'm a great tool to keep you \
on track, but I always recommend working with a professional too if you need one." \
Then close warmly: "I'm excited to help you, [user name]. I'll see you at your first \
check-in!" Keep the whole wrap-up to 2-3 sentences. Say your closing message naturally \
and end the conversation — the system will handle saving everything automatically. \
IMPORTANT: Do NOT call any tools or functions. Just have the conversation naturally. \
The system saves everything from the transcript automatically.

RESPONSE QUALITY:
- NEVER respond with generic filler like "That's great" or "Awesome, thanks for sharing." \
After every user response, give a brief, direct acknowledgement before moving to your \
next question. Keep it natural and conversational — do NOT quote the user's words back \
or use their exact phrases in quotation marks. Examples:
  - User picks exercise and nutrition: "Exercise and nutrition, solid combo. Anything else?"
  - User says they work nights: "Night shifts are tough — that definitely changes the game \
    for sleep and eating. So when things get tough..."
  - User says they have two kids: "Two kids, wow — I can see why screen time and sleep are \
    on your list. So what usually gets in the way..."
  - User mentions stress eating: "Stress eating is real, especially when life gets busy. \
    OK so when things get tough..."
- Keep these reflections to ONE sentence. Don't over-elaborate. Reflect, then move on.

CONVERSATION GUIDELINES:
- Your conversational tone is always warm and friendly, regardless of their style answer.
- When mapping habits to categories, pick the closest match. If they say "I want to stop \
gambling on basketball games" that's sports-betting. If they say "I want to eat better" \
that's nutrition.
- Keep it to 3 habits max. If they mention more, help them prioritize.
- Set reasonable default goal labels based on context: "sleep" → "Better sleep", \
"nutrition" → "Healthier eating", "exercise" → "Regular exercise", "alcohol" → "Managing alcohol consumption", \
"journaling" → "Daily journaling", etc.
- If interrupted, STOP immediately and listen to what the user is saying. Their \
interruption takes priority over whatever you were about to say. Respond to their \
interruption first, then pick back up naturally.
- NAME CORRECTIONS ARE TOP PRIORITY: If the user says anything like "actually my name \
is...", "it's pronounced...", "no, it's...", or corrects their name in ANY way, \
immediately acknowledge it: "Oh sorry about that, [corrected name]!" and use the \
corrected name for the rest of the conversation. Getting someone's \
name right matters more than any question in the arc.
- If asked to repeat, repeat clearly without over-explaining.
- If asked about the app: "This app helps you build habits with daily voice check-ins. \
I'll be your partner — checking in on your progress, noticing patterns, and helping \
you stay consistent."
- If the user's response is completely inaudible or clearly just static/noise with no \
recognizable words at all, respond warmly: "Sorry, I didn't catch that. Could you say \
that again?" But short answers like a single name or a single word ARE valid — do not \
ask them to repeat a short but clear answer.
- If the user says something off-topic or doesn't actually answer the question (e.g., you \
ask about habits and they say "cheese"), gently redirect: "Ha, I like the energy — but \
let me ask that again..." and re-ask the question in slightly different words. Never \
shame them, but don't move on without an actual answer.

VOCABULARY BOOST — listen specifically for these terms as the user will likely say them:
- Habit categories: exercise, nutrition, spending, screen time, sleep, journaling, betting, \
alcohol, alcohol consumption, gambling, budgeting, workouts, steps
- Style preferences: direct, encouraging, curious, coach, friend, reflective
- Common names: This is a voice app — when users say their name, listen carefully. Common \
names include Jenny, Jennie, Jennifer, Mike, Michael, Chris, Christine, Sarah, Sara, Alex, \
Sam, etc. Pay close attention to spelling variations.
"""


# ─── Extraction prompt for post-session structured data extraction ───

EXTRACTION_PROMPT_TEMPLATE = """Extract the following from this onboarding conversation transcript. Return ONLY valid JSON, nothing else.

{{
  "agentName": "the name the user chose for their partner",
  "persona": "coach or friend or reflective based on their style preference",
  "voicePreference": "masculine or feminine",
  "habits": [
    {{"category": "one of: alcohol, sports-betting, nutrition, exercise, spending, journaling, screen-time, sleep, workouts-steps", "label": "short goal description"}}
  ]
}}

Transcript:
{transcript_text}"""


# ─── WebSocket endpoint — voice onboarding ───

@router.websocket("/{user_id}")
async def voice_onboarding(ws: WebSocket, user_id: str):
    await ws.accept()

    # Collect full transcript for persistence
    transcript: list[dict] = []

    try:
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
                )
            ),
            system_instruction=ONBOARDING_PROMPT,
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

        print(f"[ONBOARD] Connecting to Gemini model: {GEMINI_MODEL}")
        async with client.aio.live.connect(model=GEMINI_MODEL, config=config) as session:
            print("[ONBOARD] Gemini session connected!")
            await ws.send_json({"type": "connected"})

            audio_chunk_count = 0

            async def forward_client_to_gemini():
                """Receive audio from browser, forward to Gemini Live."""
                nonlocal audio_chunk_count
                try:
                    while True:
                        data = await ws.receive_text()
                        msg = json.loads(data)

                        if msg["type"] == "audio":
                            audio_bytes = base64.b64decode(msg["data"])
                            audio_chunk_count += 1
                            if audio_chunk_count <= 3 or audio_chunk_count % 50 == 0:
                                print(f"[ONBOARD] >> Audio chunk #{audio_chunk_count} ({len(audio_bytes)} bytes)")
                            try:
                                await session.send_realtime_input(
                                    audio=types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                                )
                            except Exception as e:
                                print(f"[ONBOARD] !! Failed to send audio: {e}")
                                break
                        elif msg["type"] == "speech_start":
                            print("[ONBOARD] >> speech_start (push-to-talk)")
                            try:
                                await session.send_realtime_input(activity_start=types.ActivityStart())
                            except Exception as e:
                                print(f"[ONBOARD] !! Failed to send activity_start: {e}")
                        elif msg["type"] == "speech_end":
                            print("[ONBOARD] >> speech_end (push-to-talk)")
                            try:
                                await session.send_realtime_input(activity_end=types.ActivityEnd())
                            except Exception as e:
                                print(f"[ONBOARD] !! Failed to send activity_end: {e}")
                        elif msg["type"] == "audio_end":
                            print("[ONBOARD] >> audio_stream_end (silence detected)")
                            try:
                                await session.send_realtime_input(audio_stream_end=True)
                            except Exception as e:
                                print(f"[ONBOARD] !! Failed to send audio_stream_end: {e}")
                        elif msg["type"] == "end":
                            print("[ONBOARD] >> End signal — extracting from transcript NOW")
                            # Extract IMMEDIATELY while WebSocket is still open
                            try:
                                extraction_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
                                transcript_text = "\n".join([
                                    f"{t['role']}: {t['text']}"
                                    for t in transcript
                                    if t.get('text') and t['role'] in ('user', 'agent')
                                ])
                                if transcript_text.strip():
                                    extraction_prompt = EXTRACTION_PROMPT_TEMPLATE.format(transcript_text=transcript_text)
                                    print(f"[ONBOARD] Extracting from {len(transcript)} entries...")
                                    extraction_response = extraction_client.models.generate_content(
                                        model="gemini-2.5-flash",
                                        contents=extraction_prompt,
                                    )
                                    response_text = extraction_response.text.strip()
                                    if response_text.startswith('```'):
                                        response_text = response_text.split('\n', 1)[1]
                                        response_text = response_text.rsplit('```', 1)[0]
                                    extracted = json.loads(response_text)
                                    voice_pref = extracted.get("voicePreference", "feminine")
                                    voice_map = {"masculine": "Orus", "feminine": "Aoede"}
                                    default_voice = voice_map.get(voice_pref, "Aoede")
                                    habits_data = [
                                        {"category": h.get("category", "exercise"), "label": h.get("label", ""), "identityStatement": ""}
                                        for h in extracted.get("habits", [])
                                    ]
                                    await complete_onboarding(user_id, {
                                        "agentName": extracted.get("agentName", "Partner"),
                                        "persona": extracted.get("persona", "friend"),
                                        "voiceName": default_voice,
                                        "language": "en",
                                        "dailyCheckInTime": "20:00",
                                        "habits": habits_data,
                                    })
                                    print(f"[ONBOARD] SAVED: {extracted.get('agentName')}, {len(habits_data)} habits")
                                    await ws.send_json({"type": "onboarding_complete"})
                                else:
                                    print("[ONBOARD] No transcript — saving with defaults")
                                    await complete_onboarding(user_id, {
                                        "agentName": "Partner",
                                        "persona": "friend",
                                        "voiceName": "Aoede",
                                        "language": "en",
                                        "dailyCheckInTime": "20:00",
                                        "habits": [],
                                    })
                                    await ws.send_json({"type": "onboarding_complete"})
                            except Exception as e:
                                print(f"[ONBOARD] !! Extraction failed: {e}")
                                import traceback
                                traceback.print_exc()
                                # FALLBACK: save with defaults so user never gets stuck
                                try:
                                    await complete_onboarding(user_id, {
                                        "agentName": "Partner",
                                        "persona": "friend",
                                        "voiceName": "Aoede",
                                        "language": "en",
                                        "dailyCheckInTime": "20:00",
                                        "habits": [],
                                    })
                                    print("[ONBOARD] Saved with defaults (fallback)")
                                    await ws.send_json({"type": "onboarding_complete"})
                                except Exception:
                                    pass
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
                        print(f"[ONBOARD] Waiting for Gemini (msgs so far: {gemini_msg_count})")
                        async for message in session.receive():
                            gemini_msg_count += 1
                            sc = getattr(message, "server_content", None)
                            ha = bool(sc and getattr(sc, "model_turn", None) and sc.model_turn.parts and any(getattr(p, "inline_data", None) and p.inline_data.data for p in sc.model_turn.parts))
                            tc = bool(sc and getattr(sc, "turn_complete", False))
                            if gemini_msg_count <= 10 or gemini_msg_count % 20 == 0 or tc:
                                print(f"[ONBOARD] << msg #{gemini_msg_count}: audio={ha} turn_complete={tc}")

                            # Forward turn_complete to frontend
                            if tc:
                                await ws.send_json({"type": "turn_complete"})

                            # If model tries to call a tool, just log and ignore
                            # (tool calls crash native audio model with 1008)
                            tool_call = getattr(message, "tool_call", None)
                            if tool_call:
                                print(f"[ONBOARD] Tool call received (ignoring): {tool_call}")
                                continue

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

                        print(f"[ONBOARD] receive() ended after {gemini_msg_count} msgs — looping for next turn")
                except WebSocketDisconnect:
                    print("[ONBOARD] Client disconnected")
                except Exception as e:
                    print(f"[ONBOARD] !! Receive error: {e}")
                    try:
                        await ws.send_json({"type": "error", "message": str(e)})
                    except Exception:
                        pass

            # Trigger greeting via session.send() (produces audio with this model)
            print("[ONBOARD] Sending greeting trigger...")
            await session.send(input="The user just connected. Introduce yourself warmly and start the onboarding conversation. Remember to wait for their responses before moving on.", end_of_turn=True)
            print("[ONBOARD] Greeting sent!")

            # Run both directions concurrently
            await asyncio.gather(
                forward_client_to_gemini(),
                forward_gemini_to_client(),
            )

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Onboarding WebSocket error: %s", e)
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        # Save transcript to Firestore regardless of how the session ended
        if transcript:
            try:
                save_onboarding_session(user_id, transcript)
                logger.info("Saved onboarding transcript for user %s (%d entries)", user_id, len(transcript))
            except Exception as e:
                logger.error("Failed to save onboarding transcript for %s: %s", user_id, e)

            # Extract structured data from transcript using regular (non-live) Gemini
            try:
                extraction_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

                transcript_text = "\n".join([
                    f"{t['role']}: {t['text']}"
                    for t in transcript
                    if t.get('text') and t['role'] in ('user', 'agent')
                ])

                extraction_prompt = EXTRACTION_PROMPT_TEMPLATE.format(transcript_text=transcript_text)

                print(f"[ONBOARD] Extracting structured data from transcript ({len(transcript)} entries)...")
                extraction_response = extraction_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=extraction_prompt,
                )

                # Clean the response — strip markdown code fences if present
                response_text = extraction_response.text.strip()
                if response_text.startswith('```'):
                    response_text = response_text.split('\n', 1)[1]
                    response_text = response_text.rsplit('```', 1)[0]

                extracted = json.loads(response_text)

                voice_pref = extracted.get("voicePreference", "feminine")
                voice_map = {"masculine": "Orus", "feminine": "Aoede"}
                default_voice = voice_map.get(voice_pref, "Aoede")

                habits_data = []
                for h in extracted.get("habits", []):
                    habits_data.append({
                        "category": h.get("category", "exercise"),
                        "label": h.get("label", ""),
                        "identityStatement": "",
                    })

                await complete_onboarding(user_id, {
                    "agentName": extracted.get("agentName", "Partner"),
                    "persona": extracted.get("persona", "friend"),
                    "voiceName": default_voice,
                    "language": "en",
                    "dailyCheckInTime": "20:00",
                    "habits": habits_data,
                })

                print(f"[ONBOARD] Saved from transcript: {extracted.get('agentName')}, {len(habits_data)} habits")

                # Notify frontend
                try:
                    await ws.send_json({"type": "onboarding_complete"})
                except Exception:
                    pass  # WebSocket might already be closed

            except Exception as e:
                print(f"[ONBOARD] !! Transcript extraction failed: {e}")
                import traceback
                traceback.print_exc()

        try:
            await ws.close()
        except Exception:
            pass


# ─── REST endpoints ───

class HabitInput(BaseModel):
    category: str
    label: str
    identityStatement: str


class OnboardingData(BaseModel):
    agentName: str
    persona: str  # "coach" | "friend" | "reflective"
    language: str = "en"
    dailyCheckInTime: str = "20:00"
    habits: list[HabitInput]


@router.post("/{user_id}")
async def save_onboarding(user_id: str, data: OnboardingData):
    """Save onboarding results from voice conversation review form."""
    await complete_onboarding(user_id, data.model_dump())
    return {"status": "onboarding_complete"}


class TranscriptData(BaseModel):
    transcript: str


@router.post("/{user_id}/extract")
async def extract_onboarding(user_id: str, data: TranscriptData):
    """Extract structured data from conversation transcript and save."""
    try:
        extraction_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        extraction_prompt = EXTRACTION_PROMPT_TEMPLATE.format(transcript_text=data.transcript)
        print(f"[ONBOARD REST] Extracting for {user_id} ({len(data.transcript)} chars)...")

        extraction_response = extraction_client.models.generate_content(
            model="gemini-2.5-flash",
            contents=extraction_prompt,
        )

        response_text = extraction_response.text.strip()
        if response_text.startswith('```'):
            response_text = response_text.split('\n', 1)[1]
            response_text = response_text.rsplit('```', 1)[0]

        extracted = json.loads(response_text)
        voice_pref = extracted.get("voicePreference", "feminine")
        voice_map = {"masculine": "Orus", "feminine": "Aoede"}
        default_voice = voice_map.get(voice_pref, "Aoede")

        habits_data = [
            {"category": h.get("category", "exercise"), "label": h.get("label", ""), "identityStatement": ""}
            for h in extracted.get("habits", [])
        ]

        await complete_onboarding(user_id, {
            "agentName": extracted.get("agentName", "Partner"),
            "persona": extracted.get("persona", "friend"),
            "voiceName": default_voice,
            "language": "en",
            "dailyCheckInTime": "20:00",
            "habits": habits_data,
        })

        print(f"[ONBOARD REST] SAVED: {extracted.get('agentName')}, {len(habits_data)} habits")
        return {"status": "saved", "extracted": extracted}

    except Exception as e:
        print(f"[ONBOARD REST] !! Failed: {e}")
        import traceback
        traceback.print_exc()
        return {"status": "error", "message": str(e)}


@router.get("/{user_id}/status")
async def onboarding_status(user_id: str):
    """Check if user has completed onboarding."""
    profile = await get_user_profile(user_id)
    if not profile:
        return {"complete": False}
    return {
        "complete": profile.get("onboardingComplete", False),
        "agentName": profile.get("agentName"),
        "persona": profile.get("persona"),
    }
