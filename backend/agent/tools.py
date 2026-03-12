"""
ADK Tool definitions for the Accountability Partner agent.
These are the tools the agent can call during a voice check-in session.
See adk-system-prompt.md TOOL CALL REFERENCE section.
"""

from google.adk.tools import FunctionTool
from services.firestore_service import (
    get_user_profile,
    get_habits,
    get_recent_photos,
    get_photos_for_habit,
    get_last_checkin_session,
    get_checkin_sessions,
    save_checkin_session,
    update_streak,
    detect_patterns,
)


# ─── get_user_context ───

async def get_user_context(user_id: str) -> dict:
    """Get the full user context including profile, habits, recent photos, and last session.
    Called at the start of every check-in session."""
    profile = await get_user_profile(user_id)
    if not profile:
        return {"error": "User not found"}

    habits = get_habits(user_id)
    last_session = get_last_checkin_session(user_id)

    last_checkin_time = None
    if last_session and last_session.get("timestamp"):
        last_checkin_time = last_session["timestamp"]
    recent_photos = get_recent_photos(user_id, since=last_checkin_time)

    return {
        "profile": profile,
        "habits": habits,
        "recentPhotos": recent_photos,
        "lastSession": last_session,
    }


get_user_context_tool = FunctionTool(get_user_context)


# ─── decide_habits_to_cover ───

async def decide_habits_to_cover(user_id: str) -> dict:
    """Decide which habits to cover in this session and in what order.
    Priority: 1) Habits with photos since last check-in, 2) Habits not discussed in 5+ days,
    3) Habits with streak risk. Called at the start of every check-in session."""
    from datetime import datetime, timezone, timedelta

    habits = get_habits(user_id)
    last_session = get_last_checkin_session(user_id)

    last_checkin_time = None
    if last_session and last_session.get("timestamp"):
        last_checkin_time = last_session["timestamp"]

    recent_photos = get_recent_photos(user_id, since=last_checkin_time)
    photo_habit_ids = {p.get("habitId") for p in recent_photos}

    now = datetime.now(timezone.utc)
    priority_1 = []  # Has photos
    priority_2 = []  # Not discussed in 5+ days
    priority_3 = []  # Streak risk
    other = []

    for habit in habits:
        habit_id = habit.get("id")
        last_ci = habit.get("lastCheckIn")

        if habit_id in photo_habit_ids:
            priority_1.append({
                "habitId": habit_id,
                "category": habit.get("category"),
                "label": habit.get("label"),
                "reason": "Photos logged since last check-in",
                "photoCount": len([p for p in recent_photos if p.get("habitId") == habit_id]),
            })
        elif last_ci and (now - last_ci.replace(tzinfo=timezone.utc) if not last_ci.tzinfo else now - last_ci) > timedelta(days=5):
            priority_2.append({
                "habitId": habit_id,
                "category": habit.get("category"),
                "label": habit.get("label"),
                "reason": f"Not discussed in {(now - (last_ci.replace(tzinfo=timezone.utc) if not last_ci.tzinfo else last_ci)).days} days",
            })
        elif habit.get("currentStreak", 0) > 3 and last_ci and (now - (last_ci.replace(tzinfo=timezone.utc) if not last_ci.tzinfo else last_ci)) > timedelta(days=2):
            priority_3.append({
                "habitId": habit_id,
                "category": habit.get("category"),
                "label": habit.get("label"),
                "reason": f"Streak of {habit.get('currentStreak')} at risk — no activity in {(now - (last_ci.replace(tzinfo=timezone.utc) if not last_ci.tzinfo else last_ci)).days} days",
            })
        elif not last_ci:
            priority_2.append({
                "habitId": habit_id,
                "category": habit.get("category"),
                "label": habit.get("label"),
                "reason": "Never discussed",
            })
        else:
            other.append({
                "habitId": habit_id,
                "category": habit.get("category"),
                "label": habit.get("label"),
                "reason": "Regular check-in",
            })

    ordered = priority_1 + priority_2 + priority_3 + other
    return {
        "habitsToAddress": ordered,
        "totalHabits": len(habits),
        "recommendation": "Focus on depth over breadth. If one habit opens a meaningful conversation, stay with it.",
    }


decide_habits_to_cover_tool = FunctionTool(decide_habits_to_cover)


# ─── get_recent_photos_tool ───

async def get_recent_photos_for_habit(user_id: str, habit_id: str) -> dict:
    """Get photos logged since the last check-in for a specific habit.
    Called when the agent wants to reference photos during the conversation."""
    photos = get_photos_for_habit(user_id, habit_id)
    return {
        "photos": [
            {
                "habitCategory": p.get("habitCategory"),
                "timestamp": str(p.get("timestamp")),
                "description": p.get("visionDescription", "No description"),
            }
            for p in photos
        ],
        "count": len(photos),
    }


get_recent_photos_tool = FunctionTool(get_recent_photos_for_habit)


# ─── detect_patterns_tool ───

async def detect_habit_patterns(user_id: str, habit_id: str) -> dict:
    """Detect behavioral patterns for a specific habit based on check-in history.
    Called during check-in when patterns are relevant to the conversation."""
    patterns = detect_patterns(user_id, habit_id)
    return {"patterns": patterns, "habitId": habit_id}


detect_patterns_tool = FunctionTool(detect_habit_patterns)


# ─── save_checkin_summary_tool ───

async def save_session_summary(
    user_id: str,
    summary: str,
    habits_covered: list[str],
    micro_commitment: str,
    patterns_flagged: list[str],
    streak_updates: dict[str, str],
) -> dict:
    """Save the check-in session summary to Firestore. Called at the end of every session.
    streak_updates is a dict of habitId -> outcome ('maintained', 'broken', 'unknown')."""
    session_id = save_checkin_session(user_id, {
        "summary": summary,
        "habitsCovered": habits_covered,
        "microCommitment": micro_commitment,
        "patternsFlagged": patterns_flagged,
        "streakUpdates": streak_updates,
    })

    # Update streaks for each habit
    for habit_id, outcome in streak_updates.items():
        update_streak(user_id, habit_id, outcome)

    return {"sessionId": session_id, "status": "saved"}


save_checkin_summary_tool = FunctionTool(save_session_summary)


# ─── update_streak_tool ───

async def update_habit_streak(user_id: str, habit_id: str, outcome: str) -> dict:
    """Update the streak for a specific habit.
    outcome: 'maintained' (streak continues), 'broken' (reset to 0), 'unknown' (no change).
    Called at the end of every session for each habit discussed."""
    update_streak(user_id, habit_id, outcome)
    return {"status": "updated", "habitId": habit_id, "outcome": outcome}


update_streak_tool = FunctionTool(update_habit_streak)


# ─── All tools list ───

ALL_TOOLS = [
    get_user_context_tool,
    decide_habits_to_cover_tool,
    get_recent_photos_tool,
    detect_patterns_tool,
    save_checkin_summary_tool,
    update_streak_tool,
]
