"""Photos API — upload and retrieve photo logs with contextual state responses."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from services.firestore_service import (
    add_photo_log,
    get_recent_photos,
    get_last_checkin_session,
    get_habits,
)
from services.storage import upload_photo as gcs_upload_photo
from services.vision import analyze_photo

logger = logging.getLogger(__name__)

router = APIRouter()

# ─── Valid habit categories (mirrors lib/db.ts HABIT_CATEGORIES) ───

VALID_HABIT_CATEGORIES = {
    "alcohol",
    "sports-betting",
    "nutrition",
    "exercise",
    "spending",
    "journaling",
    "screen-time",
    "sleep",
    "workouts-steps",
}

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

ALLOWED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
}

MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB


# ─── Response models ───


class PhotoState(BaseModel):
    """Describes the contextual state used to craft the response message."""
    state: str  # "A", "B", or "C"
    label: str  # human-readable label


class PhotoUploadResponse(BaseModel):
    id: str
    imageUrl: str
    visionDescription: str
    habitId: str
    habitCategory: str
    state: PhotoState
    message: str


# ─── Photo state logic ───


async def _determine_photo_state(user_id: str) -> PhotoState:
    """
    Determine the contextual state for the user at the time of photo upload.

    State A: First log today, no check-in yet
             → Offer a check-in or let them schedule later.
    State B: Already checked in today
             → Brief acknowledgment, soft micro-reflection, no pressure.
    State C: Returning after 3+ days inactive
             → Warm re-engagement, no guilt, offer catch-up.
    """
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    three_days_ago = now - timedelta(days=3)

    # Check for recent photos (any activity at all in last 3 days)
    recent_photos = get_recent_photos(user_id, since=three_days_ago)

    # Check for today's check-in session
    last_session = get_last_checkin_session(user_id)
    checked_in_today = False
    if last_session and last_session.get("timestamp"):
        session_ts = last_session["timestamp"]
        # Firestore returns datetime objects from the Admin SDK
        if hasattr(session_ts, "timestamp"):
            # It's a datetime-like object
            checked_in_today = session_ts >= today_start
        elif isinstance(session_ts, datetime):
            checked_in_today = session_ts >= today_start

    # State C: No activity in the last 3 days (no photos, no sessions)
    has_recent_activity = len(recent_photos) > 0
    if not has_recent_activity:
        # Also check if the last session was within 3 days
        if last_session and last_session.get("timestamp"):
            session_ts = last_session["timestamp"]
            if isinstance(session_ts, datetime):
                has_recent_activity = session_ts >= three_days_ago

    if not has_recent_activity:
        return PhotoState(state="C", label="returning_after_break")

    # State B: Already checked in today
    if checked_in_today:
        return PhotoState(state="B", label="already_checked_in_today")

    # State A: First log today, no check-in yet (default)
    return PhotoState(state="A", label="first_log_today")


def _build_state_message(state: PhotoState, habit_category: str, vision_description: str) -> str:
    """
    Build a context-appropriate response message based on the photo state.
    """
    category_label = HABIT_CATEGORY_LABELS.get(habit_category, habit_category)

    if state.state == "A":
        # First log today, no check-in yet → offer check-in or schedule later
        return (
            f"Got it — your {category_label} photo is logged. "
            f"Here's what I see: {vision_description} "
            "Would you like to do a quick check-in now, or would you rather "
            "save it for your scheduled time?"
        )

    elif state.state == "B":
        # Already checked in today → brief acknowledgment, soft micro-reflection
        return (
            f"Noted! Added another {category_label} photo to today's log. "
            f"I see: {vision_description} "
            "No need for a full check-in — you've already done one today. "
            "Anything on your mind about this one, or are we good?"
        )

    elif state.state == "C":
        # Returning after 3+ days → warm re-engagement, no guilt
        return (
            f"Hey, welcome back! I see you've logged a {category_label} photo. "
            f"Here's what I notice: {vision_description} "
            "It's been a few days — no worries at all, life happens. "
            "Want to do a quick catch-up check-in to get back on track?"
        )

    # Fallback (should not reach here)
    return (
        f"Photo logged for {category_label}. "
        f"Description: {vision_description}"
    )


# ─── Endpoints ───


@router.post("/{user_id}", response_model=PhotoUploadResponse)
async def upload_photo_endpoint(
    user_id: str,
    habit_id: str = Form(...),
    habit_category: str = Form(...),
    file: UploadFile = File(...),
) -> PhotoUploadResponse:
    """
    Upload a photo for a habit log entry.

    Full pipeline:
    1. Validate the upload (file type, size, habit category).
    2. Upload to Google Cloud Storage.
    3. Analyze with Gemini Flash for a vision description.
    4. Save metadata to Firestore.
    5. Determine the contextual state and build a response message.
    """

    # ── Validate habit category ──
    if habit_category not in VALID_HABIT_CATEGORIES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid habit_category '{habit_category}'. "
                   f"Must be one of: {', '.join(sorted(VALID_HABIT_CATEGORIES))}",
        )

    # ── Validate file MIME type ──
    content_type = file.content_type or "application/octet-stream"
    if content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '{content_type}'. "
                   f"Accepted types: {', '.join(sorted(ALLOWED_MIME_TYPES))}",
        )

    # ── Read file data ──
    try:
        file_data = await file.read()
    except Exception as exc:
        logger.error("Failed to read uploaded file: %s", exc)
        raise HTTPException(status_code=400, detail="Could not read uploaded file.")

    if len(file_data) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    if len(file_data) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE_BYTES // (1024 * 1024)} MB.",
        )

    # ── Validate habit_id belongs to user ──
    habits = get_habits(user_id)
    habit_ids = {h["id"] for h in habits}
    if habit_id not in habit_ids:
        raise HTTPException(
            status_code=404,
            detail=f"Habit '{habit_id}' not found for user '{user_id}'.",
        )

    # ── Step 1: Upload to Google Cloud Storage ──
    try:
        image_url = await gcs_upload_photo(
            user_id=user_id,
            file_data=file_data,
            filename=file.filename or "photo.jpg",
            content_type=content_type,
        )
    except Exception as exc:
        logger.error("GCS upload failed for user %s: %s", user_id, exc)
        raise HTTPException(
            status_code=502,
            detail="Failed to upload photo to storage. Please try again.",
        )

    # ── Step 2: Analyze with Gemini Flash ──
    habit_context = HABIT_CATEGORY_LABELS.get(habit_category, habit_category)
    try:
        vision_description = await analyze_photo(
            image_data=file_data,
            mime_type=content_type,
            habit_context=habit_context,
        )
    except Exception as exc:
        logger.warning("Vision analysis failed for user %s: %s", user_id, exc)
        # Non-fatal: we still save the photo, just without a description
        vision_description = "Photo uploaded — vision analysis unavailable"

    # ── Step 3: Save metadata to Firestore ──
    try:
        photo_id = add_photo_log(user_id, {
            "habitId": habit_id,
            "habitCategory": habit_category,
            "imageUrl": image_url,
            "visionDescription": vision_description,
        })
    except Exception as exc:
        logger.error("Firestore save failed for user %s: %s", user_id, exc)
        raise HTTPException(
            status_code=502,
            detail="Photo was uploaded but failed to save metadata. Please try again.",
        )

    # ── Step 4: Determine state and build response message ──
    try:
        state = await _determine_photo_state(user_id)
    except Exception as exc:
        logger.warning("State determination failed for user %s: %s", user_id, exc)
        state = PhotoState(state="A", label="first_log_today")

    message = _build_state_message(state, habit_category, vision_description)

    return PhotoUploadResponse(
        id=photo_id,
        imageUrl=image_url,
        visionDescription=vision_description,
        habitId=habit_id,
        habitCategory=habit_category,
        state=state,
        message=message,
    )


@router.get("/{user_id}")
async def list_photos(
    user_id: str,
    since: Optional[str] = None,
    habit_id: Optional[str] = None,
) -> list[dict]:
    """
    List recent photos for a user.

    Query parameters:
    - since: ISO 8601 datetime string to filter photos from (e.g. "2026-03-01T00:00:00").
    - habit_id: Optional habit ID to filter photos for a specific habit.
    """
    since_dt: Optional[datetime] = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since).replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid 'since' datetime format: '{since}'. Use ISO 8601 format.",
            )

    try:
        photos = get_recent_photos(user_id, since=since_dt)
    except Exception as exc:
        logger.error("Failed to fetch photos for user %s: %s", user_id, exc)
        raise HTTPException(status_code=502, detail="Failed to retrieve photos.")

    # If habit_id filter is provided, apply it client-side
    # (get_recent_photos doesn't filter by habit_id directly)
    if habit_id:
        photos = [p for p in photos if p.get("habitId") == habit_id]

    return photos
