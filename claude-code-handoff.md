# Accountability Partner — Claude Code Build Guide
**Gemini Live Agent Challenge | Deadline: March 16, 2026**

---

## What We're Building

A voice-first AI accountability partner that helps users stay consistent with
up to 3 personal habits using real-time voice check-ins and photo logging.
The agent remembers history, notices patterns, and speaks like a real partner —
not a chatbot. Built on Google's Gemini Live API and ADK, hosted on GCP.

This is a solo hackathon build. Prioritize working software over polish.
Demo-ability matters more than completeness.

---

## Hackathon Requirements (Non-Negotiable)

- Must use Gemini Live API or ADK
- Must use Google GenAI SDK or ADK
- Must use at least one Google Cloud service
- Backend must be hosted on Google Cloud (Cloud Run preferred)
- Must submit: demo video, architecture diagram, public repo, Cloud deployment proof

---

## Locked Decisions

- **Platform:** Web (primary) + mobile React Native (if time allows)
- **Auth:** Firebase Auth — Google login + email/password
- **Database:** Firestore
- **File storage:** Google Cloud Storage (photo uploads)
- **Backend:** Python / FastAPI on Cloud Run
- **Voice:** Gemini Live API (real-time, interruptible)
- **Vision:** Gemini Flash (photo analysis)
- **Agent framework:** Google ADK
- **Languages:** English + Spanish
- **Visual vibe:** Warm, minimal — soft colors, clean cards
- **Agent name:** Set by user at onboarding
- **Persona:** Chosen by user at onboarding (coach / friend / reflective)
  — affects tone and voice style, NOT emotional depth
- **Habits:** Up to 3 per user, chosen from a predefined category list
- **Post-photo behavior:** Context-aware (see Photo Logic section)
- **Neglected habit:** Proactive reminder after 3+ days no activity
- **Multi-habit check-ins:** Agent decides which habits to cover based on activity

---

## Still To Decide (Work Through With Me)

- App name (direction: abstract and brandable)
- Primary demo habit story (leaning: sports betting)
- Mobile push notification approach for reminders

## Decided

- **UI library:** shadcn/ui (Radix + Tailwind)
- **Firestore schema:** Finalized — UserProfile (agentName, persona, language, dailyCheckInTime, onboardingComplete), Habits (category, label, identityStatement, streaks), PhotoLogs, CheckInSessions
- **Onboarding:** Voice-first with editable review form at the end
- **Voice architecture:** Server-mediated (browser ↔ WebSocket ↔ FastAPI ↔ Gemini Live) — keeps API keys server-side, enables agent tool calls mid-session

---

## Core Features to Build

### 1. Authentication
Firebase Auth with Google login and email/password.
Simple — get it working and move on.

### 2. Onboarding Flow
Voice-first conversation that collects:
- Agent name (user picks what to call it)
- Persona style (coach / friend / reflective)
- Up to 3 habits from a category list
- For each habit: a goal statement and an identity statement
  ("I am someone who...")
- Preferred daily check-in time
- Language preference (English / Spanish)

All data saved to Firestore. Decide with me whether this is fully voice,
hybrid, or has a UI fallback.

### 3. Habit Categories (v1)
Pre-defined list the user picks from at onboarding:
- Alcohol / Drinking
- Sports Betting
- Nutrition / Intentional Eating
- Movement / Exercise
- Spending
- Journaling / Reflection
- Screen Time / Digital Habits
- Sleep (manual verbal only — no device integration in v1)
- Workouts / Steps (manual verbal only — no device integration in v1)

### 4. Photo Logging
User taps a habit, takes or uploads a photo, photo goes to GCS.
After upload, agent responds based on context state:

- **State A — First log today, no check-in yet:**
  Offer a check-in or let them schedule one later

- **State B — Already checked in today:**
  Brief acknowledgment, soft optional micro-reflection, no pressure

- **State C — Returning after 3+ days inactive:**
  Warm re-engagement, no guilt, offer a catch-up check-in

Goal: nothing should discourage logging. Keep friction near zero.

Gemini Flash analyzes each photo and stores a plain-language description
alongside the image reference in Firestore.

### 5. Voice Check-In Session (The Core Feature)
Real-time voice conversation using Gemini Live API + ADK.
The agent:
- Loads user context from Firestore at session start
- Decides which habits to cover (prioritize: has photos → long absence → streak risk)
- References photos logged since last check-in
- Asks follow-up questions, surfaces patterns, adapts to persona style
- Closes every session with an identity anchor + one micro-commitment
- Saves a session summary + micro-commitment to Firestore

Full ADK system prompt spec is in `adk-system-prompt.md` — refer to that.

### 6. Streak & Pattern Detection
After each check-in, update streaks per habit.
Pattern detection queries recent check-in history and surfaces
observations to the agent during sessions. Work with me on the
exact query logic and thresholds.

### 7. Proactive Reminder
If no photo log or check-in in 3+ days, send the user a reminder.
Notification approach TBD — work with me on this.

### 8. Must-Have UI Screens
- **Home / Dashboard** — habit cards, streak counters, photo log button
- **Check-In Session** — live voice interface, waveform, interruptible
- **Check-In History** — past sessions list with summaries
- **Weekly Summary** — recap of all habits, streaks, flagged patterns
- **Onboarding** — voice-first flow

Nice to have but not required: photo log gallery, settings screen.

---

## ADK System Prompt

Full spec lives in `adk-system-prompt.md`. It covers:
- Core identity and therapy guardrail
- James Clear behavioral framework (baked into agent instincts)
- Three persona blocks (coach / friend / reflective)
- Dynamic user context injection template
- Session decision logic
- Bilingual support
- Closing ritual (identity anchor + micro-commitment)

The prompt is assembled dynamically at session start from Firestore data.
Work with me on the assembly logic and how variables get injected.

---

## What's Deferred to v2

Don't build these now:
- Wearable integrations (Apple Health, Google Fit, Fitbit, Garmin)
- Weekly digest email
- Social / accountability pairs
- Habit recommendation engine

---

## Eight-Day Build Order (Rough)

| Day | Focus |
|---|---|
| 1 | GCP setup, FastAPI skeleton, Firestore schema, Firebase Auth |
| 2 | Photo upload pipeline, GCS, Gemini Flash analysis, photo state logic |
| 3 | ADK agent core, Firestore tools, single-habit check-in working |
| 4 | Gemini Live API voice streaming, persona voice differentiation |
| 5 | Multi-habit logic, pattern detection, streak updates, reminders |
| 6 | Onboarding flow, React frontend, dashboard + history screens |
| 7 | Polish, edge cases, demo script, architecture diagram |
| 8 | Demo video, deployment proof, README, Devpost submission |

---

## Files to Reference

- `adk-system-prompt.md` — full agent prompt spec
- `accountability-partner-roadmap.md` — full product decisions and flows

---

*Ask me before making major architectural decisions not covered here.*
