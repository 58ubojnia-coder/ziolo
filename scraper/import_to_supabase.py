#!/usr/bin/env python3
"""
import_to_supabase.py — pushes strains.json (produced by scrape_budcare.py)
into your Supabase `strains` table.

Usage:
    pip install requests --break-system-packages
    python3 import_to_supabase.py \
        --url https://YOUR-PROJECT.supabase.co \
        --key YOUR_ANON_OR_SERVICE_KEY \
        --file strains.json

This "upserts" on the `slug` column, so re-running it after a fresh scrape
just updates existing rows and adds new ones — it won't create duplicates.
"""

import argparse
import json
import sys

import requests


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="Your Supabase project URL, e.g. https://xxxx.supabase.co")
    ap.add_argument("--key", required=True, help="Your Supabase anon (or service_role) API key")
    ap.add_argument("--file", default="strains.json")
    args = ap.parse_args()

    with open(args.file, encoding="utf-8") as f:
        strains = json.load(f)

    endpoint = args.url.rstrip("/") + "/rest/v1/strains"
    headers = {
        "apikey": args.key,
        "Authorization": f"Bearer {args.key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }

    batch_size = 25
    ok, failed = 0, 0
    for i in range(0, len(strains), batch_size):
        batch = strains[i : i + batch_size]
        r = requests.post(
            endpoint + "?on_conflict=slug",
            headers=headers,
            data=json.dumps(batch),
            timeout=30,
        )
        if r.status_code in (200, 201, 204):
            ok += len(batch)
            print(f"  upserted rows {i+1}-{i+len(batch)}")
        else:
            failed += len(batch)
            print(f"  !! batch {i+1}-{i+len(batch)} failed: {r.status_code} {r.text[:300]}")

    print(f"\nDone. {ok} rows upserted, {failed} failed out of {len(strains)} total.")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
