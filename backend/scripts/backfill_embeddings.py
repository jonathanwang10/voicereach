#!/usr/bin/env python3
"""
Embed the people and visit transcripts in the database (H2-4.4).

    cd backend && python scripts/backfill_embeddings.py --stale   # only what's missing or changed (the usual run)
    cd backend && python scripts/backfill_embeddings.py           # re-embed everyone

--stale embeds rows that are missing, from another model, or whose text changed
(a label edit or an is_sensitive flip changes the text). It is the same code path as
POST /api/embeddings/generate-all (services/embedding_refresh.py). Prints counts and
at most 5 errors, as ids and error types only, never names.
"""
import argparse
import asyncio
import os
import sys
from typing import List, Optional

from dotenv import load_dotenv

# Add the backend directory (this file's parent's parent) to the Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db.client import get_supabase  # noqa: E402
from services.embedding_refresh import refresh_embeddings  # noqa: E402


async def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="backfill_embeddings.py")
    parser.add_argument("--stale", action="store_true",
                        help="only rows that are missing, from another model, or whose text changed")
    args = parser.parse_args(argv)
    load_dotenv()
    report = await refresh_embeddings(get_supabase(), stale_only=args.stale)
    print(f"People embedded: {report.individuals_embedded}, already fresh: {report.individuals_fresh}")
    print(f"Visits embedded: {report.interactions_embedded}, already fresh: {report.interactions_fresh}")
    if report.errors:
        print(f"Errors: {len(report.errors)}")
        for error in report.errors[:5]:
            print(f"  - {error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
