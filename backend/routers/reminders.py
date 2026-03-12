"""
Reminders API — triggered by Cloud Scheduler (cron).
Finds inactive users (3+ days) and sends persona-appropriate reminders.
"""

from fastapi import APIRouter, Header, HTTPException
from services.reminders import process_reminders

router = APIRouter()


@router.post("/check")
async def check_and_send_reminders(
    x_cloudscheduler: str | None = Header(None, alias="X-CloudScheduler"),
):
    """
    Called by Cloud Scheduler daily. Finds users inactive 3+ days
    and sends reminders.

    In production, verify the X-CloudScheduler header or use IAM
    to restrict access. For now, the endpoint is open.
    """
    results = process_reminders()
    return {
        "processed": len(results),
        "reminders": results,
    }
