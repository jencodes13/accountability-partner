"""
Proactive reminder system.
Detects users inactive for 3+ days and triggers reminders.
Designed to be called by Cloud Scheduler → Cloud Run endpoint.

Delivery channel is stubbed — currently logs the reminder.
Can be wired to email (SendGrid), browser push, or SMS later.
"""

import logging
from datetime import datetime, timedelta, timezone

from services.firebase_admin import get_db

logger = logging.getLogger(__name__)


def find_inactive_users(days_threshold: int = 3) -> list[dict]:
    """
    Find users who have no photo logs or check-in sessions
    in the last `days_threshold` days and have completed onboarding.
    Returns list of user dicts with uid, displayName, agentName, habits info.
    """
    db = get_db()
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_threshold)

    # Get all users who completed onboarding
    users_ref = db.collection("users").where("onboardingComplete", "==", True)
    users = users_ref.get()

    inactive = []

    for user_doc in users:
        user = user_doc.to_dict()
        uid = user.get("uid")
        if not uid:
            continue

        # Check for recent sessions
        sessions = (
            db.collection("users").document(uid).collection("sessions")
            .where("timestamp", ">=", cutoff)
            .limit(1)
            .get()
        )
        if len(sessions) > 0:
            continue

        # Check for recent photos
        photos = (
            db.collection("users").document(uid).collection("photos")
            .where("timestamp", ">=", cutoff)
            .limit(1)
            .get()
        )
        if len(photos) > 0:
            continue

        # User is inactive — gather context for the reminder
        habits = db.collection("users").document(uid).collection("habits").get()
        habit_summaries = []
        for h in habits:
            hd = h.to_dict()
            habit_summaries.append({
                "category": hd.get("category"),
                "label": hd.get("label"),
                "currentStreak": hd.get("currentStreak", 0),
            })

        inactive.append({
            "uid": uid,
            "displayName": user.get("displayName", ""),
            "email": user.get("email", ""),
            "agentName": user.get("agentName", "Partner"),
            "persona": user.get("persona", "friend"),
            "habits": habit_summaries,
        })

    return inactive


def build_reminder_message(user: dict) -> str:
    """Build a persona-appropriate reminder message."""
    agent = user.get("agentName", "Partner")
    persona = user.get("persona", "friend")
    habits = user.get("habits", [])

    # Pick the habit with the highest streak at risk
    at_risk = sorted(habits, key=lambda h: h.get("currentStreak", 0), reverse=True)
    habit_mention = ""
    if at_risk and at_risk[0].get("currentStreak", 0) > 0:
        h = at_risk[0]
        habit_mention = f" Your {h['label']} streak is at {h['currentStreak']} days — let's keep it going."
    elif at_risk:
        habit_mention = f" Let's check in on {at_risk[0].get('label', 'your habits')}."

    if persona == "coach":
        return f"Hey — it's {agent}. Haven't heard from you in a few days.{habit_mention} Let's get back on it."
    elif persona == "reflective":
        return f"Hi, it's {agent}. It's been a little while.{habit_mention} Whenever you're ready, I'm here."
    else:  # friend
        return f"Hey! {agent} here. Been a few days — just checking in.{habit_mention} No pressure, just wanted to say hi."


def process_reminders() -> list[dict]:
    """
    Main entry point: find inactive users, build messages, deliver (stubbed).
    Returns list of reminders sent (for logging/API response).
    """
    inactive = find_inactive_users(days_threshold=3)
    results = []

    for user in inactive:
        message = build_reminder_message(user)

        # ── Delivery stub ──
        # TODO: Wire to actual delivery channel (email, push, SMS)
        logger.info(
            "REMINDER [%s] → %s (%s): %s",
            user.get("uid"),
            user.get("displayName"),
            user.get("email"),
            message,
        )

        results.append({
            "uid": user["uid"],
            "displayName": user.get("displayName"),
            "message": message,
            "delivered": False,  # Set True when actual delivery is wired
            "channel": "none",  # Will be "email", "push", etc.
        })

    return results
