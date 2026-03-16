# Accountability Partner

A voice-first AI habit tracking platform built for the Gemini Live Agent Challenge 2026.

**Live App:** [ai-accountability-partner.vercel.app](https://ai-accountability-partner.vercel.app)

## What It Does

Talk to an AI partner who listens, sees, remembers, and holds you accountable. Voice check-ins, photo sharing, and real-time conversation — no logging, no typing.

- Voice-first onboarding and daily check-ins via Gemini Live API
- Photo sharing during sessions — the agent sees and responds to what you share
- Personalized coaching style (direct, encouraging, or reflective)
- Habit tracking with streak management
- Context-aware conversations that remember your history

## Tech Stack

- **Frontend:** Next.js 15, React 19, TypeScript, Tailwind CSS
- **Backend:** Python, FastAPI, WebSockets
- **AI:** Google GenAI SDK, Google ADK, Gemini Live API, Gemini 2.5 Flash
- **Cloud:** Google Cloud Run, Firebase Auth, Cloud Firestore
- **Audio:** Web Audio API (16kHz PCM), real-time bidirectional streaming

## Reproducible Testing Instructions

### Prerequisites
- Node.js 18+
- Python 3.11+
- Google Cloud account with billing enabled
- Gemini API key

### 1. Clone the repo
```bash
git clone https://github.com/jencodes13/accountability-partner.git
cd accountability-partner
```

### 2. Set up the frontend
```bash
npm install
```

Create `.env.local` with your Firebase and Gemini credentials:
```
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
NEXT_PUBLIC_GEMINI_API_KEY=your_gemini_api_key
NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:8000
```

### 3. Set up the backend
```bash
cd backend
pip install -r requirements.txt
```

Create `backend/.env` with:
```
GEMINI_API_KEY=your_gemini_api_key
```

### 4. Run locally
```bash
# From project root — runs both frontend and backend
npm run dev
```

Frontend: http://localhost:3000
Backend: http://localhost:8000

### 5. Deploy to Google Cloud Run
```bash
# Set your project
gcloud config set project your-project-id

# Deploy backend
chmod +x deploy.sh
./deploy.sh
```

### 6. Test the app
1. Sign in with Google
2. Complete voice onboarding (say hello, pick habits, choose a coaching style)
3. Start a check-in — talk about your habits
4. Share a photo during the check-in using the camera button
5. Try interrupting the agent mid-sentence

## Architecture

See `architecture-diagram.html` for the full system architecture diagram.

## Google Cloud Services Used

- **Cloud Run** — Backend hosting (FastAPI + WebSocket server)
- **Cloud Firestore** — User profiles, habits, session transcripts
- **Firebase Auth** — Google sign-in + email/password
- **Gemini Live API** — Real-time bidirectional voice (Google GenAI SDK)
- **Gemini 2.5 Flash** — Photo analysis via Google ADK InMemoryRunner
