"""Google Cloud Storage for photo uploads."""

import os
import uuid
from datetime import timedelta
from google.cloud import storage


def get_storage_client():
    return storage.Client()


def get_bucket():
    bucket_name = os.getenv("GCS_BUCKET", "accountability-partner-photos")
    client = get_storage_client()
    return client.bucket(bucket_name)


async def upload_photo(user_id: str, file_data: bytes, filename: str, content_type: str) -> str:
    """Upload a photo to GCS and return the public URL."""
    bucket = get_bucket()
    ext = filename.rsplit(".", 1)[-1] if "." in filename else "jpg"
    blob_name = f"photos/{user_id}/{uuid.uuid4().hex}.{ext}"
    blob = bucket.blob(blob_name)

    blob.upload_from_string(file_data, content_type=content_type)

    # Generate a signed URL valid for 7 days (for the agent to reference)
    url = blob.generate_signed_url(
        version="v4",
        expiration=timedelta(days=7),
        method="GET",
    )

    return url
