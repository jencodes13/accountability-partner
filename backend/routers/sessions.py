"""
Voice Check-In Sessions — WebSocket endpoint.
Browser <-> FastAPI (WebSocket) <-> ADK Agent (Gemini Live)

Flow:
1. Client connects via WebSocket with userId
2. Server loads user context from Firestore
3. Server creates ADK agent with tools and assembled system prompt
4. Audio streams bidirectionally: client <-> server <-> Gemini Live
5. Agent can call tools mid-conversation (pattern detection, etc.)
6. On session end, agent saves check-in summary via tool call
"""

import asyncio
import base64
import json
import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai.types import (
    LiveConnectConfig,
    Modality,
    SpeechConfig,
    VoiceConfig,
    PrebuiltVoiceConfig,
)

from agent.prompt_builder import build_system_prompt
from services.firestore_service import (
    get_user_profile,
    get_habits,
    get_recent_photos,
    get_last_checkin_session,
    get_checkin_sessions,
)

router = APIRouter()

GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-09-2025"

# Map persona to Gemini voice preset
PERSONA_VOICES = {
    "coach": "Kore",       # More assertive/direct
    "friend": "Zephyr",    # Warm/casual
    "reflective": "Puck",  # Calm/thoughtful
}


@router.websocket("/{user_id}")
async def voice_session(ws: WebSocket, user_id: str):
    await ws.accept()

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

        config = LiveConnectConfig(
            response_modalities=[Modality.AUDIO],
            speech_config=SpeechConfig(
                voice_config=VoiceConfig(
                    prebuilt_voice_config=PrebuiltVoiceConfig(voice_name=voice_name)
                )
            ),
            system_instruction=system_prompt,
            input_audio_transcription={},
            output_audio_transcription={},
        )

        async with client.aio.live.connect(model=GEMINI_MODEL, config=config) as session:
            await ws.send_json({"type": "connected", "voice": voice_name, "persona": persona})

            # 5. Bidirectional streaming
            async def forward_client_to_gemini():
                """Receive audio/video from browser, forward to Gemini."""
                try:
                    while True:
                        data = await ws.receive_text()
                        msg = json.loads(data)

                        if msg["type"] == "audio":
                            await session.send_realtime_input(
                                media={"data": msg["data"], "mime_type": "audio/pcm;rate=16000"}
                            )
                        elif msg["type"] == "video":
                            await session.send_realtime_input(
                                media={"data": msg["data"], "mime_type": "image/jpeg"}
                            )
                        elif msg["type"] == "end":
                            break
                except WebSocketDisconnect:
                    pass

            async def forward_gemini_to_client():
                """Receive audio/transcription from Gemini, forward to browser."""
                try:
                    async for message in session.receive():
                        server_content = message.server_content
                        if not server_content:
                            # Check for tool calls
                            if hasattr(message, "tool_call") and message.tool_call:
                                await ws.send_json({
                                    "type": "tool_activity",
                                    "tool": message.tool_call.function_calls[0].name if message.tool_call.function_calls else "unknown",
                                })
                            continue

                        # Handle interruption
                        if server_content.interrupted:
                            await ws.send_json({"type": "interrupted"})
                            continue

                        # Forward audio
                        if server_content.model_turn and server_content.model_turn.parts:
                            for part in server_content.model_turn.parts:
                                if part.inline_data and part.inline_data.data:
                                    audio_b64 = base64.b64encode(part.inline_data.data).decode()
                                    await ws.send_json({
                                        "type": "audio",
                                        "data": audio_b64,
                                    })
                                if part.text:
                                    await ws.send_json({
                                        "type": "transcript",
                                        "role": "agent",
                                        "text": part.text,
                                    })

                        # Handle transcriptions
                        if hasattr(server_content, "input_transcription") and server_content.input_transcription:
                            await ws.send_json({
                                "type": "transcript",
                                "role": "user",
                                "text": server_content.input_transcription.text,
                            })

                        if hasattr(server_content, "output_transcription") and server_content.output_transcription:
                            await ws.send_json({
                                "type": "transcript",
                                "role": "agent",
                                "text": server_content.output_transcription.text,
                            })
                except Exception as e:
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
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
