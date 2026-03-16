"""Photo analysis agent using Google ADK."""

from google.adk.agents import Agent

photo_analysis_agent = Agent(
    model="gemini-2.5-flash-preview-05-20",
    name="photo_analyzer",
    description="Analyzes photos shared during check-in sessions to identify habits, food, exercise, or daily life context.",
    instruction="""You are a photo analysis assistant for a habit tracking app.
When shown a photo, describe what you see in 1-2 natural sentences.
Focus on what's relevant to health, habits, food, exercise, or daily life.
Be specific about what you observe. Do not make judgments or assumptions about the person's habits.
Keep your description factual and concise.""",
)
