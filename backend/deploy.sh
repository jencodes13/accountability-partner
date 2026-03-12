#!/bin/bash
# Deploy the FastAPI backend to Google Cloud Run.
#
# Prerequisites:
#   1. gcloud CLI installed and authenticated
#   2. GOOGLE_CLOUD_PROJECT env var set (or pass as argument)
#   3. GCS bucket created for photos
#   4. Gemini API key set in Cloud Run env vars
#
# Usage:
#   ./deploy.sh                          # uses default project
#   ./deploy.sh my-project-id            # specify project

set -euo pipefail

PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-accountability-partner-4c1ec}}"
REGION="us-central1"
SERVICE_NAME="accountability-partner-api"
GCS_BUCKET="${GCS_BUCKET:-accountability-partner-photos}"

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
  aiplatform.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

# Create GCS bucket if it doesn't exist
echo "Ensuring GCS bucket exists..."
gsutil ls -b "gs://$GCS_BUCKET" 2>/dev/null || \
  gsutil mb -p "$PROJECT_ID" -l "$REGION" "gs://$GCS_BUCKET"

# Set CORS on bucket for web uploads
echo "Setting CORS policy on bucket..."
cat > /tmp/cors.json <<'CORS'
[
  {
    "origin": ["*"],
    "method": ["GET", "PUT", "POST"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
CORS
gsutil cors set /tmp/cors.json "gs://$GCS_BUCKET"

# Build and deploy
echo "Building and deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --source=. \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GCS_BUCKET=$GCS_BUCKET" \
  --memory=1Gi \
  --cpu=1 \
  --timeout=300 \
  --min-instances=0 \
  --max-instances=5

# Get the service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format="value(status.url)")

echo ""
echo "=== Deployment complete ==="
echo "Service URL: $SERVICE_URL"
echo ""
echo "Next steps:"
echo "  1. Set GEMINI_API_KEY:"
echo "     gcloud run services update $SERVICE_NAME --region=$REGION --set-env-vars=GEMINI_API_KEY=your-key"
echo "  2. Set FRONTEND_URL to your deployed frontend:"
echo "     gcloud run services update $SERVICE_NAME --region=$REGION --update-env-vars=FRONTEND_URL=https://your-frontend.com"
echo "  3. Update your frontend's NEXT_PUBLIC_BACKEND_WS_URL to: ${SERVICE_URL/https/wss}"
echo ""
echo "  4. (Optional) Set up Cloud Scheduler for reminders:"
echo "     gcloud scheduler jobs create http accountability-reminders \\"
echo "       --schedule='0 20 * * *' \\"
echo "       --uri='$SERVICE_URL/api/reminders/check' \\"
echo "       --http-method=POST \\"
echo "       --location=$REGION"
