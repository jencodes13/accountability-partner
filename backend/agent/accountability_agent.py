"""
ADK Agent definition for the Accountability Partner.
Uses Google ADK with Gemini Live for voice check-in sessions.
"""

from google.adk.agents import Agent
from agent.prompt_builder import build_system_prompt
from agent.tools import ALL_TOOLS

GEMINI_MODEL = "gemini-2.5-flash-preview-native-audio-dialog"


def create_agent(
    profile: dict,
    habits: list,
    recent_photos: list,
    last_session: dict | None,
    sessions: list[dict] | None = None,
) -> Agent:
    """Create an ADK agent configured for a specific user's check-in session."""

    system_prompt = build_system_prompt(
        profile=profile,
        habits=habits,
        recent_photos=recent_photos,
        last_session=last_session,
        sessions=sessions,
    )

    agent = Agent(
        model=GEMINI_MODEL,
        name=profile.get("agentName", "Partner"),
        instruction=system_prompt,
        tools=ALL_TOOLS,
    )

    return agent
