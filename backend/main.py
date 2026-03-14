"""
Accountability Partner — FastAPI Backend
Handles voice sessions (WebSocket), photo uploads, and agent logic.
"""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from routers import sessions, habits, photos, onboarding, reminders, messages  # noqa: E402
from services.firebase_admin import initialize_firebase  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    initialize_firebase()
    yield
    # Shutdown (cleanup if needed)


app = FastAPI(
    title="Accountability Partner API",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow the Next.js frontend
frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_url, "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(sessions.router, prefix="/api/sessions", tags=["sessions"])
app.include_router(habits.router, prefix="/api/habits", tags=["habits"])
app.include_router(photos.router, prefix="/api/photos", tags=["photos"])
app.include_router(onboarding.router, prefix="/api/onboarding", tags=["onboarding"])
app.include_router(reminders.router, prefix="/api/reminders", tags=["reminders"])
app.include_router(messages.router, prefix="/api/messages", tags=["messages"])


@app.get("/health")
async def health():
    return {"status": "ok"}
