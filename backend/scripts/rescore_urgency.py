#!/usr/bin/env python3
"""
Re-score every individual's stored urgency_score with the current categories.

Run this once after upgrading (next to backfill_embeddings.py): rows saved under
the old urgency maths keep their old score until re-saved. Only rows whose score
changes are written; urgency_override is never touched. Creating a weighted
category in the app re-scores everyone automatically, so this is also the repair
if that re-score failed. Reads up to PostgREST's ~1000-row cap.

    cd backend && python scripts/rescore_urgency.py
"""
import os
import sys
from dotenv import load_dotenv

# Add the backend directory (this file's parent's parent) to the Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.individual_service import rescore_all_individuals  # noqa: E402
from supabase import create_client, Client  # noqa: E402


def get_supabase_client() -> Client:
    """Get Supabase client instance"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be provided")
    return create_client(url, key)


def main():
    load_dotenv()
    try:
        updated = rescore_all_individuals(get_supabase_client())
    except Exception as e:
        # Type only; the traceback below (raise) is the operator's own terminal
        print(f"Re-score failed: {type(e).__name__}")
        raise
    print(f"Re-scored urgency: {updated} individuals updated")


if __name__ == "__main__":
    main()
