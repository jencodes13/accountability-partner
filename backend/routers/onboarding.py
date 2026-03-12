"""Onboarding API — save voice onboarding results."""

from fastapi import APIRouter
from pydantic import BaseModel
from services.firestore_service import complete_onboarding, get_user_profile

router = APIRouter()


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
    """Save onboarding results from voice conversation review."""
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
