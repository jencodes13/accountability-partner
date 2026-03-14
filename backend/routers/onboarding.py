"""
Onboarding API — voice onboarding via Gemini Live + REST save endpoint.

WebSocket flow:
1. Client connects with userId
2. Gemini Live guides the user through onboarding via voice
3. All transcripts (user + agent) are collected for later review
4. When the agent has gathered all info, it calls save_onboarding_results tool
5. Server sends onboarding_complete message to client with structured data
6. On disconnect, full transcript is saved to Firestore
7. Client shows review form → user edits → POST saves to Firestore
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
Your job is to have a natural voice conversation to learn about the user and set up their \
accountability partner.

OPENING: Start by introducing yourself and the app. Keep it brief and warm — 2-3 sentences max. \
Something like: "Hey! Welcome. I'm going to be your accountability partner. I'll check in with you \
every day to help you stay on track with the habits you care about. Let me learn a little about you \
so I can set things up." Then ask your first question. Do NOT rush — wait for the user to respond \
before moving on.

PACING: You must ask one question at a time and WAIT for the user to respond before continuing. \
Do NOT gather multiple pieces of information from a single response and assume you have everything. \
Do NOT call the save tool until you have explicitly asked about and received answers for: \
at least one habit with its goal and identity statement, the persona preference, and the agent name. \
If the user hasn't spoken yet or has only said brief greetings, keep the conversation going — \
do NOT assume you have enough information to save.

You need to gather the following information through conversation:

1. HABITS (up to 3): Ask what habits they want to work on. For each habit, understand:
   - The category (must be one of: alcohol, sports-betting, nutrition, exercise, spending, \
journaling, screen-time, sleep, workouts-steps)
   - A short label describing their specific goal (e.g., "No drinks on weekdays", \
"Walk 10k steps daily")
   - An identity statement — who they want to become (e.g., "I am someone who takes care of \
their body", "I am someone who is intentional with money")

2. PERSONA PREFERENCE: Describe three styles and ask which feels right:
   - Coach: Direct, warm, high-expectation. Doesn't let you off the hook.
   - Friend: Casual, real, supportive. Like a friend who genuinely cares.
   - Reflective: Calm, thoughtful, asks questions. Helps you find your own insights.

3. AGENT NAME: Ask what they'd like to call their accountability partner.

CONVERSATION GUIDELINES:
- Be conversational and warm. This is a voice conversation, not a form.
- Ask about one thing at a time. Don't rush through everything.
- Help them craft identity statements if they struggle — suggest options based on what they said.
- When mapping habits to categories, pick the closest match. If they say "I want to stop \
gambling on basketball games" that's sports-betting. If they say "I want to eat better" \
that's nutrition.
- Keep it to 3 habits max. If they mention more, help them prioritize.
- After gathering everything, summarize what you heard and ask if it looks right.
- Once confirmed, call the save_onboarding_results tool with all the data.

TONE: Warm but efficient. You're excited to help them get started. Not clinical, not overly \
enthusiastic. Like a trusted friend helping them set something up.

CONVERSATION FLOW:
- If interrupted, stop and listen. Pick back up naturally.
- If asked off-topic questions, engage briefly (1-2 sentences) then redirect: \
"Anyway — let's keep setting things up."
- If asked about the app: "This app helps you build habits with daily voice check-ins. \
I'll be your partner — checking in on your progress, tracking streaks, and helping \
you stay consistent."
- If there's silence, wait a beat, then gently prompt: "Still there? No rush."
- If asked to repeat, repeat clearly without over-explaining."""

# ─── Tool definition for structured data extraction ───

ONBOARDING_TOOL = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="save_onboarding_results",
            description=(
                "Call this ONLY after you have had a full conversation with the user and gathered "
                "ALL required information: at least one habit (with category, goal label, and identity "
                "statement), their persona preference (coach/friend/reflective), and a name for their "
                "accountability partner. You MUST have asked the user about each of these separately "
                "and received their spoken responses. Do NOT call this based on assumptions or if the "
                "user has only said a greeting. After gathering everything, summarize what you heard "
                "and ask the user to confirm before calling this tool."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "agentName": types.Schema(
                        type="STRING",
                        description="The name the user chose for their accountability partner",
                    ),
                    "persona": types.Schema(
                        type="STRING",
                        description="The accountability style: coach, friend, or reflective",
                        enum=["coach", "friend", "reflective"],
                    ),
                    "habit1_category": types.Schema(
                        type="STRING",
                        description="Category for habit 1",
                        enum=[
                            "alcohol", "sports-betting", "nutrition", "exercise",
                            "spending", "journaling", "screen-time", "sleep", "workouts-steps",
                        ],
                    ),
                    "habit1_label": types.Schema(
                        type="STRING",
                        description="Short goal description for habit 1",
                    ),
                    "habit1_identity": types.Schema(
                        type="STRING",
                        description="Identity statement for habit 1",
                    ),
                    "habit2_category": types.Schema(
                        type="STRING",
                        description="Category for habit 2 (empty string if no second habit)",
                    ),
                    "habit2_label": types.Schema(
                        type="STRING",
                        description="Short goal description for habit 2",
                    ),
                    "habit2_identity": types.Schema(
                        type="STRING",
                        description="Identity statement for habit 2",
                    ),
                    "habit3_category": types.Schema(
                        type="STRING",
                        description="Category for habit 3 (empty string if no third habit)",
                    ),
                    "habit3_label": types.Schema(
                        type="STRING",
                        description="Short goal description for habit 3",
                    ),
                    "habit3_identity": types.Schema(
                        type="STRING",
                        description="Identity statement for habit 3",
                    ),
                },
                required=["agentName", "persona", "habit1_category", "habit1_label", "habit1_identity"],
            ),
        )
    ]
)


def _parse_habits_from_tool_args(args: dict) -> list[dict]:
    """Extract habit list from flat tool call arguments."""
    habits = []
    for i in range(1, 4):
        cat = args.get(f"habit{i}_category", "")
        label = args.get(f"habit{i}_label", "")
        identity = args.get(f"habit{i}_identity", "")
        if cat and label:
            habits.append({
                "category": cat,
                "label": label,
                "identityStatement": identity,
            })
    return habits


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
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Zephyr")
                )
            ),
            system_instruction=ONBOARDING_PROMPT,
            tools=[ONBOARDING_TOOL],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
        )

        async with client.aio.live.connect(model=GEMINI_MODEL, config=config) as session:
            await ws.send_json({"type": "connected"})

            # Prompt the model to introduce itself and start the conversation
            await session.send(input="The user just connected. Introduce yourself warmly and start the onboarding conversation. Remember to wait for their responses before moving on.", end_of_turn=True)

            async def forward_client_to_gemini():
                """Receive audio from browser, forward to Gemini Live."""
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
                try:
                    async for message in session.receive():
                        # Handle tool calls
                        tool_call = getattr(message, "tool_call", None)
                        if tool_call and tool_call.function_calls:
                            for fc in tool_call.function_calls:
                                if fc.name == "save_onboarding_results":
                                    args = fc.args or {}
                                    habits = _parse_habits_from_tool_args(args)

                                    # Record tool call in transcript
                                    transcript.append({
                                        "role": "tool_call",
                                        "tool": fc.name,
                                        "args": args,
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                    })

                                    # Send structured data to frontend
                                    await ws.send_json({
                                        "type": "onboarding_complete",
                                        "agentName": args.get("agentName", ""),
                                        "persona": args.get("persona", "friend"),
                                        "language": "en",
                                        "dailyCheckInTime": "20:00",
                                        "birthday": "",
                                        "habits": habits,
                                    })

                                    # Respond to tool call so model can wrap up
                                    await session.send(
                                        input=types.LiveClientToolResponse(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=fc.id,
                                                    name=fc.name,
                                                    response={"status": "saved", "message": "Onboarding data saved successfully."},
                                                )
                                            ]
                                        )
                                    )
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
