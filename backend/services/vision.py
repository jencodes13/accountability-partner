"""Gemini Flash vision analysis for photo logs."""

import os
from google import genai

FLASH_MODEL = "gemini-2.0-flash"


async def analyze_photo(image_data: bytes, mime_type: str, habit_context: str) -> str:
    """
    Analyze a photo using Gemini Flash and return a plain-language description.
    The description is stored alongside the photo in Firestore and used by
    the agent during check-in sessions.
    """
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    prompt = f"""Describe this image in 1-2 sentences for an accountability partner context.
The user is tracking this habit: {habit_context}
Focus on what's visible and relevant to the habit. Be factual and specific.
Examples of good descriptions:
- "FanDuel parlay slip, 3-leg NBA bet, visible amount ~$25"
- "Home-cooked salad with grilled chicken, no visible processed food"
- "Gym selfie showing weight rack, appears to be doing deadlifts"
- "Screenshot of screen time showing 3h 42m total, 1h 20m on social media"
Do not judge or editorialize. Just describe what you see."""

    response = await client.aio.models.generate_content(
        model=FLASH_MODEL,
        contents=[
            {
                "parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": mime_type, "data": image_data}},
                ]
            }
        ],
    )

    return response.text.strip() if response.text else "Unable to analyze image"
