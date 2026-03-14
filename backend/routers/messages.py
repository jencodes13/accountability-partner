"""Messages API — iMessage-style text and photo chat with the AI agent."""

import logging
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from google import genai

from services.firestore_service import (
    get_user_profile,
    get_habits,
    get_messages,
    save_message,
    add_photo_log,
)
from services.storage import upload_photo as gcs_upload_photo
from services.vision import analyze_photo

logger = logging.getLogger(__name__)

router = APIRouter()

TEXT_MODEL = "gemini-2.5-flash"

ALLOWED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
}

MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB

HABIT_CATEGORY_LABELS = {
    "alcohol": "Alcohol / Drinking",
    "sports-betting": "Sports Betting",
    "nutrition": "Nutrition / Intentional Eating",
    "exercise": "Movement / Exercise",
    "spending": "Spending",
    "journaling": "Journaling / Reflection",
    "screen-time": "Screen Time / Digital Habits",
    "sleep": "Sleep",
    "workouts-steps": "Workouts / Steps",
}


# ─── Request / Response models ───


class SendMessageRequest(BaseModel):
    text: str


class MessageResponse(BaseModel):
    id: str
    role: str
    text: str
    imageUrl: Optional[str] = None
    imageDescription: Optional[str] = None
    habitId: Optional[str] = None
    timestamp: str  # ISO format string


class SendMessageResponse(BaseModel):
    userMessage: MessageResponse
    assistantMessage: MessageResponse


# ─── Helpers ───


def _build_system_prompt(profile: dict, habits: list[dict]) -> str:
    """Build a system prompt for the text chat agent."""
    persona = profile.get("persona", "friend")
    agent_name = profile.get("agentName", "your accountability partner")
    user_name = profile.get("displayName", "").split(" ")[0] or "there"

    persona_instruction = {
        "coach": "You are direct, motivating, and action-oriented. Keep it brief and push gently.",
        "friend": "You are warm, casual, and supportive. Talk like a trusted friend.",
        "reflective": "You are calm, thoughtful, and inquisitive. Ask questions that encourage self-reflection.",
    }.get(persona, "You are warm and supportive.")

    habits_text = ""
    if habits:
        habit_lines = []
        for h in habits:
            label = HABIT_CATEGORY_LABELS.get(h.get("category", ""), h.get("category", ""))
            streak = h.get("currentStreak", 0)
            identity = h.get("identityStatement", "")
            habit_lines.append(f"- {label}: \"{h.get('label', '')}\" (streak: {streak} days, identity: \"{identity}\")")
        habits_text = "\n".join(habit_lines)

    return f"""You are {agent_name}, an accountability partner for {user_name}.
{persona_instruction}

The user is tracking these habits:
{habits_text if habits_text else "No habits set up yet."}

Guidelines:
- Keep responses concise (1-3 sentences for most messages).
- Be encouraging but honest. Never be judgmental.
- If the user shares a photo, comment on what you see and relate it to their habits.
- You can ask follow-up questions to understand context.
- Mirror the user's language and energy.
- Never use emojis.
- If a photo is related to a habit, mention which one.
- Reference streaks naturally when relevant (e.g., "that's 5 days strong").
"""


def _build_conversation_history(recent_messages: list[dict], limit: int = 20) -> list[dict]:
    """Convert Firestore messages to Gemini conversation format."""
    history = []
    # Take last N messages for context
    for msg in recent_messages[-limit:]:
        role = "user" if msg.get("role") == "user" else "model"
        text = msg.get("text", "")
        if msg.get("imageDescription"):
            text = f"[Photo: {msg['imageDescription']}] {text}".strip()
        if text:
            history.append({"role": role, "parts": [{"text": text}]})
    return history


async def _generate_agent_response(
    user_text: str,
    profile: dict,
    habits: list[dict],
    recent_messages: list[dict],
    photo_context: str | None = None,
) -> str:
    """Call Gemini to generate a contextual response."""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    system_prompt = _build_system_prompt(profile, habits)
    history = _build_conversation_history(recent_messages)

    # Build the user message content
    user_content = user_text
    if photo_context:
        user_content = f"[I'm sharing a photo. Here's what's in it: {photo_context}] {user_text}".strip()

    # Build full contents: system instruction + history + new user message
    contents = []
    if history:
        contents.extend(history)
    contents.append({"role": "user", "parts": [{"text": user_content}]})

    try:
        response = await client.aio.models.generate_content(
            model=TEXT_MODEL,
            contents=contents,
            config={
                "system_instruction": system_prompt,
                "temperature": 0.7,
                "max_output_tokens": 300,
            },
        )
        return response.text.strip() if response.text else "I'm here. What's on your mind?"
    except Exception as exc:
        logger.error("Gemini text generation failed: %s", exc)
        return "I'm having trouble responding right now. Try again in a moment."


def _determine_habit_from_description(description: str, habits: list[dict]) -> Optional[dict]:
    """Simple keyword matching to determine which habit a photo relates to."""
    desc_lower = description.lower()

    keyword_map = {
        "alcohol": ["beer", "wine", "drink", "cocktail", "bar", "liquor", "bottle", "glass", "sober"],
        "sports-betting": ["bet", "parlay", "sportsbook", "fanduel", "draftkings", "wager", "odds", "slip"],
        "nutrition": ["food", "meal", "salad", "cook", "eat", "plate", "lunch", "dinner", "breakfast", "snack", "fruit", "vegetable"],
        "exercise": ["gym", "workout", "run", "jog", "weight", "exercise", "fitness", "yoga", "stretch", "deadlift", "squat"],
        "spending": ["receipt", "purchase", "buy", "shop", "price", "cost", "transaction", "budget"],
        "journaling": ["journal", "write", "notebook", "diary", "pen", "page"],
        "screen-time": ["screen", "phone", "app", "hours", "minutes", "usage", "screen time", "social media"],
        "sleep": ["sleep", "bed", "pillow", "alarm", "wake", "rest", "nap"],
        "workouts-steps": ["steps", "walk", "pedometer", "fitbit", "watch", "activity", "move"],
    }

    for habit in habits:
        category = habit.get("category", "")
        keywords = keyword_map.get(category, [])
        for kw in keywords:
            if kw in desc_lower:
                return habit

    # Fallback: return first habit if we can't determine
    return habits[0] if habits else None


def _serialize_timestamp(ts) -> str:
    """Convert a Firestore timestamp or datetime to ISO string."""
    if ts is None:
        return ""
    if hasattr(ts, "isoformat"):
        return ts.isoformat()
    return str(ts)


# ─── Endpoints ───


@router.get("/{user_id}")
async def get_message_history(user_id: str, limit: int = 50) -> list[dict]:
    """Get message history for a user."""
    try:
        messages = get_messages(user_id, limit=limit)
        # Serialize timestamps for JSON
        for msg in messages:
            if "timestamp" in msg:
                msg["timestamp"] = _serialize_timestamp(msg["timestamp"])
        return messages
    except Exception as exc:
        logger.error("Failed to fetch messages for user %s: %s", user_id, exc)
        raise HTTPException(status_code=502, detail="Failed to retrieve messages.")


@router.post("/{user_id}", response_model=SendMessageResponse)
async def send_text_message(user_id: str, body: SendMessageRequest) -> SendMessageResponse:
    """Send a text message and get an AI response."""
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="Message text cannot be empty.")

    # Load user context
    profile = await get_user_profile(user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found.")

    habits = get_habits(user_id)
    recent_messages = get_messages(user_id, limit=20)

    # Save user message
    user_msg_data = {"role": "user", "text": body.text.strip()}
    user_msg_id = save_message(user_id, user_msg_data)

    # Generate agent response
    agent_text = await _generate_agent_response(
        user_text=body.text.strip(),
        profile=profile,
        habits=habits,
        recent_messages=recent_messages,
    )

    # Save agent response
    agent_msg_data = {"role": "assistant", "text": agent_text}
    agent_msg_id = save_message(user_id, agent_msg_data)

    now_iso = datetime.now(timezone.utc).isoformat()

    return SendMessageResponse(
        userMessage=MessageResponse(
            id=user_msg_id,
            role="user",
            text=body.text.strip(),
            timestamp=now_iso,
        ),
        assistantMessage=MessageResponse(
            id=agent_msg_id,
            role="assistant",
            text=agent_text,
            timestamp=now_iso,
        ),
    )


@router.post("/{user_id}/photo", response_model=SendMessageResponse)
async def send_photo_message(
    user_id: str,
    file: UploadFile = File(...),
    text: str = Form(default=""),
) -> SendMessageResponse:
    """Send a photo message, analyze it, log it to the right habit, and get an AI response."""

    # Validate MIME type
    content_type = file.content_type or "application/octet-stream"
    if content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '{content_type}'. Accepted: {', '.join(sorted(ALLOWED_MIME_TYPES))}",
        )

    # Read file
    try:
        file_data = await file.read()
    except Exception as exc:
        logger.error("Failed to read uploaded file: %s", exc)
        raise HTTPException(status_code=400, detail="Could not read uploaded file.")

    if len(file_data) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(file_data) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large. Maximum 10 MB.")

    # Load user context
    profile = await get_user_profile(user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found.")

    habits = get_habits(user_id)
    recent_messages = get_messages(user_id, limit=20)

    # Upload to GCS
    try:
        image_url = await gcs_upload_photo(
            user_id=user_id,
            file_data=file_data,
            filename=file.filename or "photo.jpg",
            content_type=content_type,
        )
    except Exception as exc:
        logger.error("GCS upload failed for user %s: %s", user_id, exc)
        raise HTTPException(status_code=502, detail="Failed to upload photo.")

    # Analyze with Gemini Flash vision
    matched_habit = None
    vision_description = "Photo uploaded"
    try:
        # Use general context for analysis
        habit_context = ", ".join(
            HABIT_CATEGORY_LABELS.get(h.get("category", ""), h.get("category", ""))
            for h in habits
        ) if habits else "general accountability"

        vision_description = await analyze_photo(
            image_data=file_data,
            mime_type=content_type,
            habit_context=habit_context,
        )
    except Exception as exc:
        logger.warning("Vision analysis failed: %s", exc)
        vision_description = "Photo uploaded — vision analysis unavailable"

    # Determine which habit this photo relates to
    matched_habit = _determine_habit_from_description(vision_description, habits)

    # Log photo to the matched habit
    habit_id = None
    if matched_habit:
        habit_id = matched_habit.get("id")
        try:
            add_photo_log(user_id, {
                "habitId": habit_id,
                "habitCategory": matched_habit.get("category", ""),
                "imageUrl": image_url,
                "visionDescription": vision_description,
            })
        except Exception as exc:
            logger.warning("Photo log save failed: %s", exc)

    # Save user message (with photo)
    user_caption = text.strip() if text else ""
    user_msg_data = {
        "role": "user",
        "text": user_caption,
        "imageUrl": image_url,
        "imageDescription": vision_description,
        "habitId": habit_id,
    }
    user_msg_id = save_message(user_id, user_msg_data)

    # Generate agent response with photo context
    agent_text = await _generate_agent_response(
        user_text=user_caption or "Here's a photo.",
        profile=profile,
        habits=habits,
        recent_messages=recent_messages,
        photo_context=vision_description,
    )

    # Save agent response
    agent_msg_data = {"role": "assistant", "text": agent_text, "habitId": habit_id}
    agent_msg_id = save_message(user_id, agent_msg_data)

    now_iso = datetime.now(timezone.utc).isoformat()

    return SendMessageResponse(
        userMessage=MessageResponse(
            id=user_msg_id,
            role="user",
            text=user_caption,
            imageUrl=image_url,
            imageDescription=vision_description,
            habitId=habit_id,
            timestamp=now_iso,
        ),
        assistantMessage=MessageResponse(
            id=agent_msg_id,
            role="assistant",
            text=agent_text,
            habitId=habit_id,
            timestamp=now_iso,
        ),
    )
