"""Server-side Firestore operations for the agent and API routes."""

from datetime import datetime, timezone
from typing import Optional
from google.cloud.firestore_v1 import FieldFilter
from services.firebase_admin import get_db


# ─── User Profile ───

async def get_user_profile(user_id: str) -> Optional[dict]:
    db = get_db()
    doc = db.collection("users").document(user_id).get()
    return doc.to_dict() if doc.exists else None


async def update_user_profile(user_id: str, data: dict):
    db = get_db()
    data["updatedAt"] = datetime.now(timezone.utc)
    db.collection("users").document(user_id).update(data)


async def complete_onboarding(user_id: str, data: dict):
    """Save onboarding results: agentName, persona, habits, language, checkInTime."""
    db = get_db()
    db.collection("users").document(user_id).update({
        "agentName": data["agentName"],
        "persona": data["persona"],
        "voiceName": data.get("voiceName", "Aoede"),
        "language": data.get("language", "en"),
        "dailyCheckInTime": data.get("dailyCheckInTime", "20:00"),
        "onboardingComplete": True,
        "updatedAt": datetime.now(timezone.utc),
    })

    # Create habits
    for habit in data.get("habits", []):
        add_habit(user_id, habit)


# ─── Habits ───

def add_habit(user_id: str, habit: dict) -> str:
    db = get_db()
    ref = db.collection("users").document(user_id).collection("habits").document()
    ref.set({
        "id": ref.id,
        "category": habit["category"],
        "label": habit["label"],
        "identityStatement": habit["identityStatement"],
        "currentStreak": 0,
        "longestStreak": 0,
        "lastCheckIn": None,
        "createdAt": datetime.now(timezone.utc),
    })
    return ref.id


def get_habits(user_id: str) -> list[dict]:
    db = get_db()
    docs = db.collection("users").document(user_id).collection("habits").get()
    return [doc.to_dict() for doc in docs]


def update_streak(user_id: str, habit_id: str, outcome: str):
    """Update streak for a habit. outcome: 'maintained' | 'broken' | 'unknown'"""
    db = get_db()
    ref = db.collection("users").document(user_id).collection("habits").document(habit_id)
    doc = ref.get()
    if not doc.exists:
        return

    habit = doc.to_dict()
    current = habit.get("currentStreak", 0)

    if outcome == "maintained":
        current += 1
    elif outcome == "broken":
        current = 0

    ref.update({
        "currentStreak": current,
        "longestStreak": max(habit.get("longestStreak", 0), current),
        "lastCheckIn": datetime.now(timezone.utc),
    })


# ─── Photo Logs ───

def add_photo_log(user_id: str, photo: dict) -> str:
    db = get_db()
    ref = db.collection("users").document(user_id).collection("photos").document()
    ref.set({
        "id": ref.id,
        "habitId": photo["habitId"],
        "habitCategory": photo["habitCategory"],
        "imageUrl": photo["imageUrl"],
        "visionDescription": photo.get("visionDescription", ""),
        "timestamp": datetime.now(timezone.utc),
    })
    return ref.id


def get_recent_photos(user_id: str, since: Optional[datetime] = None) -> list[dict]:
    db = get_db()
    query = db.collection("users").document(user_id).collection("photos")
    if since:
        query = query.where(filter=FieldFilter("timestamp", ">=", since))
    query = query.order_by("timestamp", direction="DESCENDING").limit(20)
    docs = query.get()
    return [doc.to_dict() for doc in docs]


def get_photos_for_habit(user_id: str, habit_id: str, since: Optional[datetime] = None) -> list[dict]:
    db = get_db()
    query = (
        db.collection("users").document(user_id).collection("photos")
        .where(filter=FieldFilter("habitId", "==", habit_id))
    )
    if since:
        query = query.where(filter=FieldFilter("timestamp", ">=", since))
    query = query.order_by("timestamp", direction="DESCENDING").limit(10)
    docs = query.get()
    return [doc.to_dict() for doc in docs]


# ─── Check-In Sessions ───

def save_checkin_session(user_id: str, session: dict) -> str:
    db = get_db()
    ref = db.collection("users").document(user_id).collection("sessions").document()
    ref.set({
        "id": ref.id,
        "summary": session["summary"],
        "habitsCovered": session.get("habitsCovered", []),
        "microCommitment": session.get("microCommitment", ""),
        "patternsFlagged": session.get("patternsFlagged", []),
        "streakUpdates": session.get("streakUpdates", {}),
        "transcript": session.get("transcript", []),
        "timestamp": datetime.now(timezone.utc),
    })
    return ref.id


def save_session_transcript(user_id: str, session_id: str, transcript: list[dict]):
    """Append or update the transcript on an existing session document."""
    db = get_db()
    ref = db.collection("users").document(user_id).collection("sessions").document(session_id)
    ref.update({"transcript": transcript})


def save_onboarding_session(user_id: str, transcript: list[dict]) -> str:
    """Save an onboarding voice session with its full transcript."""
    db = get_db()
    ref = db.collection("users").document(user_id).collection("sessions").document()
    ref.set({
        "id": ref.id,
        "type": "onboarding",
        "summary": "Voice onboarding session",
        "transcript": transcript,
        "timestamp": datetime.now(timezone.utc),
    })
    return ref.id


def get_checkin_sessions(user_id: str, limit_count: int = 10) -> list[dict]:
    db = get_db()
    query = (
        db.collection("users").document(user_id).collection("sessions")
        .order_by("timestamp", direction="DESCENDING")
        .limit(limit_count)
    )
    docs = query.get()
    return [doc.to_dict() for doc in docs]


def get_last_checkin_session(user_id: str) -> Optional[dict]:
    sessions = get_checkin_sessions(user_id, limit_count=1)
    return sessions[0] if sessions else None


# ─── Chat Messages ───

def save_message(user_id: str, message: dict) -> str:
    """Save a chat message to Firestore."""
    db = get_db()
    ref = db.collection("users").document(user_id).collection("messages").document()
    ref.set({
        "id": ref.id,
        "role": message["role"],
        "text": message.get("text", ""),
        "imageUrl": message.get("imageUrl"),
        "imageDescription": message.get("imageDescription"),
        "habitId": message.get("habitId"),
        "timestamp": datetime.now(timezone.utc),
    })
    return ref.id


def get_messages(user_id: str, limit: int = 50) -> list[dict]:
    """Get recent chat messages ordered by timestamp ascending (oldest first)."""
    db = get_db()
    query = (
        db.collection("users").document(user_id).collection("messages")
        .order_by("timestamp", direction="DESCENDING")
        .limit(limit)
    )
    docs = query.get()
    messages = [doc.to_dict() for doc in docs]
    # Reverse so oldest first (for chat display)
    messages.reverse()
    return messages


# ─── Pattern Detection ───

def detect_patterns(user_id: str, habit_id: str) -> list[str]:
    """
    Analyze recent check-in history for a habit and return pattern observations.
    This is a simple v1 — looks at streaks, day-of-week trends, and gaps.
    """
    patterns = []
    db = get_db()

    # Get recent sessions that covered this habit
    sessions = get_checkin_sessions(user_id, limit_count=14)
    relevant = [s for s in sessions if habit_id in s.get("habitsCovered", [])]

    if not relevant:
        patterns.append("No recent check-in data for this habit.")
        return patterns

    # Check for day-of-week clustering
    from collections import Counter
    days = Counter()
    for s in relevant:
        ts = s.get("timestamp")
        if ts:
            days[ts.strftime("%A")] += 1

    if days:
        most_common_day, count = days.most_common(1)[0]
        if count >= 3:
            patterns.append(f"This habit comes up most on {most_common_day}s ({count} times recently).")

    return patterns
