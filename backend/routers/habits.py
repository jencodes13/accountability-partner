"""Habits API — CRUD for user habits."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.firestore_service import get_habits, add_habit, update_streak

router = APIRouter()


class HabitCreate(BaseModel):
    category: str
    label: str
    identityStatement: str


class StreakUpdate(BaseModel):
    outcome: str  # "maintained" | "broken" | "unknown"


@router.get("/{user_id}")
async def list_habits(user_id: str):
    return get_habits(user_id)


@router.post("/{user_id}")
async def create_habit(user_id: str, habit: HabitCreate):
    existing = get_habits(user_id)
    if len(existing) >= 3:
        raise HTTPException(status_code=400, detail="Maximum of 3 habits allowed")
    habit_id = add_habit(user_id, habit.model_dump())
    return {"id": habit_id}


@router.patch("/{user_id}/{habit_id}/streak")
async def update_habit_streak(user_id: str, habit_id: str, data: StreakUpdate):
    if data.outcome not in ("maintained", "broken", "unknown"):
        raise HTTPException(status_code=400, detail="Invalid outcome")
    update_streak(user_id, habit_id, data.outcome)
    return {"status": "updated"}
