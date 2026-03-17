## Inspiration

Habit tracking apps have a fundamental problem: they add friction to the thing they're supposed to help you do. You open the app, you tap through screens, you manually log data, and if you miss a day the app makes you feel bad about it. The more barriers there are between you and the habit you're trying to build — or break — the harder it is to stick with it. I've experienced this firsthand. The apps that are supposed to help you stay consistent become one more thing you have to remember to do.

I wanted to build something that removes those barriers almost entirely. An accountability partner where all it takes is a short voice conversation or a few photos to stay on track. No forms, no dashboards to fill out, no guilt. Just a conversation with someone who remembers where you left off and helps you notice your own patterns.

The voice-first approach was intentional. Speaking is the most natural interface we have — it removes the technical blockers that stop people from tracking consistently. You don't need to know how to navigate an app. You just talk.

## What it does

The app is a voice-first AI accountability partner built on Google's Gemini Live API. Users onboard through a spoken conversation where they name their agent, choose a persona style (coach, friend, or reflective), and define up to three habits they want to track — each tied to an identity statement grounded in James Clear's Atomic Habits framework.

Check-ins happen through real-time voice sessions. The agent loads your full context — streaks, recent photos, past session notes — and decides which habits to focus on based on what matters most right now. It references photos you've logged, surfaces behavioral patterns over time, and closes every session with an identity anchor and a specific micro-commitment for tomorrow.

The agent is interruptible. You can go off-topic mid-conversation and it will acknowledge what you said, then bring you back naturally — the way a real person would.

One category I included deliberately is sports betting. Betting is becoming a larger issue in our society, and I think it's important that people have access to a zero-judgment tool that helps them stay aware of their habits while they work on them. This isn't an app that tells you to stop. It's an app that helps you see what you're doing and decide what that means for you.

## How I built it

The frontend is Next.js 15 with React 19 and Tailwind CSS, designed around a minimal dark-mode aesthetic. Authentication runs through Firebase Auth with Google login and email/password support. All user data — profiles, habits, streaks, session summaries, photo logs — lives in Firestore.

The backend is a Python FastAPI server deployed on Google Cloud Run. Voice sessions flow through a WebSocket connection: the browser captures audio, sends it to the FastAPI server, which streams it to the Gemini Live API and relays responses back in real-time. This server-mediated architecture keeps API keys off the client and enables the agent to make tool calls mid-conversation — querying Firestore for context, updating streaks, saving session summaries.

The agent itself runs on Google's Agent Development Kit (ADK). The system prompt is assembled dynamically at session start from Firestore data — injecting the user's name, agent name, persona style, active habits, streak counts, recent photo descriptions, and last session notes. Gemini Flash handles photo analysis, generating plain-language descriptions that the agent can reference during check-ins.

## Challenges I ran into

The hardest problem was building natural conversational flow with real-time interruptions. Voice AI that feels like a real conversation — where you can cut in, say something unexpected, and the agent responds appropriately before getting back on track — is a genuinely difficult interaction pattern to get right. Once I cracked it, the conversations started feeling remarkably natural, which was the moment I knew this concept worked.

Balancing scope with a solo hackathon timeline was the other constant challenge. I had to make hard cuts — the habit dashboard with visual progress tracking, a check-in calendar, Google Calendar integration for scheduled reminders — all features I want to build but had to defer to keep the core experience solid.

## What I learned

Building with the Gemini Live API taught me how much the "text box paradigm" leaves on the table. When your AI interaction is voice-first and interruptible, the entire UX changes. The user isn't crafting prompts — they're having a conversation. That shift in interaction model changes what's possible in terms of accessibility, engagement, and emotional resonance.

I also learned how much the prompt architecture matters for agent behavior. The difference between a generic "check in on habits" prompt and one that embeds behavioral science, persona variation, and session-aware context is the difference between a chatbot and something that feels like it knows you.

## What's next

This is a personal passion project that I plan to keep building. Near-term, I want to add visual dashboards for habit progress, a check-in calendar, and Google Calendar integration so users can schedule reminders that link directly into a voice check-in. Longer-term, I'd love to explore a therapist integration — an opt-in channel where your therapist could see your check-in progress over time, making this a complement to professional support rather than a replacement for it.

The app is built on a clear principle: it is not therapy and it does not replace therapy. But it can be a powerful tool used alongside it — a consistent, low-friction way for someone to stay accountable to the changes they've already decided to make.
