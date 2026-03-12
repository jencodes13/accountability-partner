# Accomplishments

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
