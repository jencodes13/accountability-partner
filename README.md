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
- **Backend:** Python 3.13, FastAPI, WebSockets
- **AI:** Google GenAI SDK, Google ADK, Gemini Live API, Gemini 2.5 Flash
- **Cloud:** Google Cloud Run, Firebase Auth, Cloud Firestore
- **Audio:** Web Audio API (16kHz PCM), real-time bidirectional streaming

## Reproducible Testing Instructions

### Prerequisites
- Node.js 18+ (tested with v22)
- Python 3.11+ (tested with 3.13)
- Google Cloud account with billing enabled
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated
- Gemini API key ([get one here](https://aistudio.google.com/apikey))
- Chrome browser recommended (best Web Audio API support)

### 1. Clone the repo
```bash
git clone https://github.com/jencodes13/accountability-partner.git
cd accountability-partner
```

### 2. Set up the frontend
```bash
npm install
```

Create `.env.local` in the project root:
```
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:8000
```

### 3. Set up the backend
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Copy the example env file and add your Gemini API key:
```bash
cp .env.example .env
```

Edit `backend/.env` and set at minimum:
```
GEMINI_API_KEY=your_gemini_api_key
```

For full Firestore access locally, you also need a Firebase service account key:
1. Go to [Firebase Console](https://console.firebase.google.com) → Project Settings → Service accounts
2. Click "Generate new private key" → save as `backend/service-account.json`
3. Set `GOOGLE_APPLICATION_CREDENTIALS=service-account.json` in `backend/.env`

> **Note:** If you skip the service account, the app will still connect to Gemini for voice but Firestore operations (saving habits, sessions) will fail locally. The [live deployment](https://ai-accountability-partner.vercel.app) uses Cloud Run's built-in credentials automatically.

### 4. Run locally
```bash
# From project root (not backend/) — runs both frontend and backend
npm run dev
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8000

### 5. Deploy to Google Cloud Run
```bash
# Authenticate and set project
gcloud auth login
gcloud config set project your-project-id

# Set your Gemini API key
export GEMINI_API_KEY="your-gemini-api-key"

# Deploy
chmod +x deploy.sh
./deploy.sh
```

The deploy script builds the Docker container, pushes to Artifact Registry, and deploys to Cloud Run with WebSocket session affinity enabled.

### 6. Test the app
1. Sign in with Google
2. Complete voice onboarding — say hello, pick habits, choose a coaching style, name your partner
3. Click "Finish & Save" when done
4. Start a check-in — talk about your habits naturally
5. Share a photo during the check-in using the camera button
6. Try interrupting the agent mid-sentence — it stops and listens

## Architecture

See `architecture-diagram.html` for the full system architecture diagram.

**High-level flow:**
```
Browser (Next.js) ←WebSocket→ FastAPI (Cloud Run) ←Gemini Live API→ Real-time Voice
                                    ↕                    ↕
                              Cloud Firestore      Gemini 2.5 Flash
                           (users, habits,        (photo analysis
                            sessions)              via Google ADK)
```

## Google Cloud Services Used

- **Cloud Run** — Backend hosting (FastAPI + WebSocket server)
- **Cloud Firestore** — User profiles, habits, session transcripts
- **Firebase Auth** — Google sign-in + email/password
- **Gemini Live API** — Real-time bidirectional voice (Google GenAI SDK)
- **Gemini 2.5 Flash** — Photo analysis + transcript extraction via Google ADK
