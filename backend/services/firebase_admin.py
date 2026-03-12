"""Firebase Admin SDK initialization for server-side Firestore access."""

import os
import firebase_admin
from firebase_admin import credentials, firestore


_db = None


def initialize_firebase():
    """Initialize Firebase Admin SDK. Call once at startup."""
    global _db
    if firebase_admin._apps:
        return

    cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    project_id = os.getenv("GOOGLE_CLOUD_PROJECT", "accountability-partner-4c1ec")

    if cred_path and os.path.exists(cred_path):
        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred, {"projectId": project_id})
    else:
        # On Cloud Run, uses default credentials automatically
        firebase_admin.initialize_app(options={"projectId": project_id})

    _db = firestore.client()


def get_db():
    """Get Firestore client. Raises if not initialized."""
    global _db
    if _db is None:
        initialize_firebase()
    return _db
