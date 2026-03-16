#!/bin/bash
# Deploy the FastAPI backend to Google Cloud Run.
#
# Prerequisites:
#   1. gcloud CLI installed and authenticated (gcloud auth login)
#   2. GEMINI_API_KEY env var set (or it will prompt)
#   3. Firebase/Firestore already provisioned in the project
#
# Usage:
#   export GEMINI_API_KEY="your-key"
#   ./deploy.sh

set -euo pipefail

PROJECT_ID="accountability-partner-4c1ec"
REGION="us-central1"
SERVICE_NAME="accountability-partner-api"

# Verify GEMINI_API_KEY is set
if [ -z "${GEMINI_API_KEY:-}" ]; then
    echo "ERROR: GEMINI_API_KEY environment variable is not set."
    echo "Run: export GEMINI_API_KEY=\"your-gemini-api-key\""
    exit 1
fi

echo "=== Deploying to Cloud Run ==="
echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Service:  $SERVICE_NAME"
echo ""

# Ensure required APIs are enabled
echo "Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

# Build and deploy
echo "Building and deploying to Cloud Run..."
cd backend
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=${GEMINI_API_KEY}" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
  --set-env-vars "GCS_BUCKET=accountability-partner-photos" \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --min-instances 0 \
  --max-instances 5 \
  --session-affinity

# Get the service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format="value(status.url)")

echo ""
echo "=== Deployment complete ==="
echo "Service URL: $SERVICE_URL"
echo "Health check: ${SERVICE_URL}/health"
echo ""
echo "Next steps:"
echo "  1. Set FRONTEND_URL to your deployed frontend for CORS:"
echo "     gcloud run services update $SERVICE_NAME --region=$REGION --project=$PROJECT_ID \\"
echo "       --update-env-vars=FRONTEND_URL=https://your-frontend.vercel.app"
echo ""
echo "  2. Update your frontend's NEXT_PUBLIC_BACKEND_URL to:"
echo "     ${SERVICE_URL}"
echo "     and NEXT_PUBLIC_BACKEND_WS_URL to:"
echo "     ${SERVICE_URL/https/wss}"
echo ""
echo "  3. (Optional) Set up Cloud Scheduler for daily reminders:"
echo "     gcloud scheduler jobs create http accountability-reminders \\"
echo "       --schedule='0 20 * * *' \\"
echo "       --uri='${SERVICE_URL}/api/reminders/check' \\"
echo "       --http-method=POST \\"
echo "       --location=$REGION"
