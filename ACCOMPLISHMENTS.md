# Accomplishments

## March 14, 2026 (Session 2)

### Onboarding Voice Bug Fixes
- Fixed stuck-listening bug: AudioContext was forcing 16kHz sample rate which browsers ignore — now uses native rate with manual resampling to 16kHz before sending to Gemini
- Fixed base64 encoding: replaced spread operator with chunked loop to prevent stack overflow on large audio buffers
- Switched onboarding voice from Zephyr to Puck (calmer, lower-pitched)
- Shrunk mic toggle button — hands-free conversation is the default, mute is optional

**Files modified:** `app/onboarding/page.tsx`, `backend/routers/onboarding.py`

### Updated Onboarding Conversation Arc
- New system prompt with 7-step flow: habit categories (light scaffolding), broad life question, per-habit follow-ups, tone preference, feedback lean, agent name
- Conversational tone always stays friend; feedback lean (direct/encouraging/curious) determines how the agent delivers feedback during check-ins
- Tool definition: identity statements no longer required (removed from required fields)

**Files modified:** `backend/routers/onboarding.py`

### Review Form Updates
- Removed birthday field and identity statement inputs
- Persona labels changed from Coach/Friend/Reflective to Direct/Encouraging/Curious
- Section label changed from "Style" to "Feedback style"
- Partner name field now full-width

**Files modified:** `app/onboarding/page.tsx`
**Files deleted:** `docs/superpowers/specs/2026-03-12-frontend-redesign-design.md`

**Commit:** `a432d13c`

---

## March 14, 2026 (Session 1)

### Complete Backend Build
- Built out all backend capabilities: voice onboarding WebSocket with Gemini Live, check-in sessions with `save_checkin_summary` tool calling, transcript persistence for all sessions
- Messages API: text + photo endpoints with Gemini Flash for AI responses and vision analysis, GCS photo upload, keyword-based habit matching
- Registered messages router in `main.py`, added Firestore CRUD for messages collection

**Files modified:** `backend/main.py`, `backend/routers/onboarding.py`, `backend/routers/sessions.py`, `backend/services/firestore_service.py`
**Files added:** `backend/routers/messages.py`

### iMessage-Style Messaging Page
- New chat UI accessible from home page nav (MessageCircle icon)
- User bubbles (sage-tinted, right-aligned) and assistant bubbles (dark card, left-aligned)
- Photo upload with file picker, typing indicator, auto-scroll, auth guards with onboarding redirect
- Error toast for invalid file types/sizes

**Files added:** `app/messages/page.tsx`
**Files modified:** `app/page.tsx`, `lib/db.ts`

### Aurora Voice UI on Check-in Page
- Replaced WaveformBars with 4-layer Aurora orb (same as onboarding)
- Audio-reactive morphing via RMS detection on both mic input and agent playback
- Ref-based DOM updates at 60fps (no React re-renders)
- Transcript accumulation: agent message history, in-progress text with blinking cursor, last user text display
- Auto-reset speaker state after agent audio finishes

**Files modified:** `app/check-in/page.tsx`

### Conversation Edge Case Prompts
- Added CONVERSATION_EDGE_CASES section to check-in system prompt: interruptions, off-topic redirect, app questions, emotional moments, silence handling, repeated questions
- Added CONVERSATION FLOW section to onboarding prompt
- Onboarding: pacing instructions to prevent premature tool calls, proper agent intro before questions

**Files modified:** `backend/agent/prompt_builder.py`, `backend/routers/onboarding.py`

### Critical Bug Fixes
- AudioContext sample rate mismatch: separated mic capture (16kHz) and playback (system default) into two contexts
- Stale `ws.onclose` closure: used ref instead of captured state value
- Auth guards: onboarding redirect added to check-in and messages pages
- Transcript concatenation: added missing space between same-role chunks
- Chunked base64 encoding: replaced spread operator on large typed arrays to avoid call stack overflow
- Removed dead code: unused capturePhoto, videoRef, canvasRef, non-functional More button

**Files modified:** `app/check-in/page.tsx`, `app/messages/page.tsx`

### Dev Experience
- `npm run dev` now starts both frontend (port 3000) and backend (port 8000) via `concurrently`
- Next.js API rewrites proxy REST calls to backend transparently
- Pinned frontend to port 3000 to prevent drift

**Files modified:** `package.json`, `next.config.ts`

**Commit:** `545857e9`

---

## March 12, 2026

### Project Cleanup & Firebase Migration
- Switched Firebase config from AI Studio project to `accountability-partner-4c1ec` (env vars instead of hardcoded JSON)
- Provisioned Firestore database and deployed security rules
- Enabled Email/Password and Google Sign-In auth providers
- Connected GitHub remote (SSH)
- Removed unused files: `firebase.js`, `firebase-applet-config.json`, `firebase-blueprint.json`, `metadata.json`, `architecture-diagram.html`, `plan.md`, Strava API routes, `hooks/use-mobile.ts`, `components/theme-toggle.tsx`
- Removed unused packages: `recharts`, `@hookform/resolvers`, `motion`, `@google/genai`, `@base-ui-components/react`, all Radix UI packages, `class-variance-authority`
- Removed all shadcn/ui components (no longer imported by any page)

**Files modified:** `lib/firebase.ts`, `next.config.ts`, `package.json`, `package-lock.json`
**Files deleted:** `firebase.js`, `firebase-applet-config.json`, `firebase-blueprint.json`, `metadata.json`, `app/api/strava/`, `hooks/`, `components/ui/`, `components/theme-toggle.tsx`
**Files added:** `firebase.json`, `.firebaserc`, `firestore.indexes.json`

### Onboarding Redirect Fix
- Fixed race condition: `createUserProfile` now awaited before checking onboarding status
- Added error handling so Firestore failures still redirect to onboarding
- New users and users without `onboardingComplete: true` are always sent to `/onboarding`

**Files modified:** `app/page.tsx`

### Voice-Native Onboarding Rebuild
- Complete rewrite of `app/onboarding/page.tsx` — replaced form-first approach with voice-native design
- Three-phase flow: intro (animated orb + "Say hello"), listening (orb responds to voice), review (pre-filled form)
- Animated sage orb as visual representation of the AI partner (breathing, speaking, listening states)
- "Not now — schedule our first check-in" option for users not ready to talk
- Review form: partner name, birthday, persona selector (pill buttons), check-in time, habits with category/goal/identity
- Page size reduced from 118 kB to 6.7 kB by removing all shadcn and Gemini SDK dependencies
- Uses WebSocket to backend (same architecture as check-in page)

**Files modified:** `app/onboarding/page.tsx`

### Check-in Page: Audio-Only
- Removed camera/video permission request — now audio only
- Removed camera button from session controls
- Removed hidden video element

**Files modified:** `app/check-in/page.tsx`

### Agent Name: User-Chosen
- Removed hardcoded "Max" fallback from home page and check-in page
- Agent name now comes from onboarding (user names their partner)

**Files modified:** `app/page.tsx`, `app/check-in/page.tsx`

### Auth Loading Timeout
- Added 5-second timeout fallback in auth provider to prevent infinite loading state

**Files modified:** `components/auth-provider.tsx`
