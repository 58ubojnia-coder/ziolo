#!/usr/bin/env python3
"""
scrape_budcare.py — pulls the full strain (odmiany) catalog from budcare.pl
into a single JSON file you can import into Supabase.

Usage:
    pip install requests beautifulsoup4 --break-system-packages   # (or in a venv)
    python3 scrape_budcare.py                     # scrapes everything, writes strains.json
    python3 scrape_budcare.py --limit 20           # just the first 20 (for testing)
    python3 scrape_budcare.py --out my_strains.json

Notes:
- This is a polite scraper: it waits `DELAY` seconds between requests and
  identifies itself with a normal browser User-Agent. Please don't crank the
  delay down and hammer the site.
- Parsing is done by matching the Polish text labels budcare.pl uses
  ("THC:", "CBD:", "Producent:", "Genetyka:", ...) rather than by relying on
  CSS class names, because Elementor (the page builder budcare.pl uses)
  generates class names that can change on any redeploy. If budcare.pl
  changes its wording, tweak the regexes in `parse_strain_page`.
- Re-run this any time you want fresh data — it's safe to run repeatedly,
  it just overwrites the output JSON. Then re-import into Supabase
  (see import_to_supabase.py) to update your catalog.
"""

import argparse
import json
import re
import sys
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE = "https://budcare.pl"
ARCHIVE_URL = BASE + "/odmiany/"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}
DELAY = 1.0  # seconds between requests — be polite


def get_soup(url):
    r = requests.get(url, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return BeautifulSoup(r.text, "html.parser")


def _extract_strain_links(soup):
    """Grab every /odmiany/<slug>/ link that looks like a strain detail page,
    regardless of which heading level or class wraps it (Elementor's markup
    for this varies)."""
    found = []
    for a in soup.select("a[href*='/odmiany/']"):
        href = a.get("href")
        if not href:
            continue
        href = href.split("?")[0].split("#")[0]
        norm = href.rstrip("/")
        # skip the archive root itself and any /page/N/ pagination links
        if norm == ARCHIVE_URL.rstrip("/"):
            continue
        if "/odmiany/page/" in norm:
            continue
        found.append(href if href.endswith("/") else href + "/")
    return found


def collect_strain_urls(max_pages=60):
    """Walk the paginated /odmiany/ archive and collect every strain detail URL.

    Rather than relying on finding a "Next" link (whose exact text/markup can
    vary and silently breaks the crawl if it doesn't match), we just keep
    requesting page/2/, page/3/, ... until a page 404s or comes back with no
    strain links on it. That's the same stopping condition either way, but it
    doesn't depend on guessing the pagination widget's text.
    """
    urls = []
    seen_this_run = set()
    page = 1
    while page <= max_pages:
        page_url = ARCHIVE_URL if page == 1 else urljoin(ARCHIVE_URL, f"page/{page}/")
        print(f"[list] fetching page {page}: {page_url}")
        try:
            soup = get_soup(page_url)
        except requests.HTTPError as e:
            print(f"  stopped (HTTP error: {e})")
            break

        found_this_page = _extract_strain_links(soup)
        found_this_page = list(dict.fromkeys(found_this_page))

        if not found_this_page:
            print("  no strain links found on this page, stopping")
            break

        new_ones = [u for u in found_this_page if u not in seen_this_run]
        if not new_ones:
            print("  page repeats an earlier page, stopping")
            break

        for u in new_ones:
            seen_this_run.add(u)
            urls.append(u)

        print(f"  +{len(new_ones)} strains (running total: {len(urls)})")
        page += 1
        time.sleep(DELAY)

    return urls


def _text_after_label(full_text, label, stop_chars=200):
    """Find `label` in the page text and return the chunk of text right after it."""
    idx = full_text.find(label)
    if idx == -1:
        return None
    chunk = full_text[idx + len(label): idx + len(label) + stop_chars]
    return chunk.strip()


def _first_number(s):
    if not s:
        return None
    m = re.search(r"(\d+(?:[.,]\d+)?)", s)
    if not m:
        return None
    return float(m.group(1).replace(",", "."))


def parse_strain_page(url):
    soup = get_soup(url)
    text = soup.get_text("\n", strip=True)

    # Name: prefer the H1, fall back to the og:title meta
    h1 = soup.find("h1")
    name = h1.get_text(strip=True) if h1 else None
    if not name:
        og = soup.find("meta", property="og:title")
        if og:
            name = og["content"].split(" - BudCare")[0].strip()

    thc = _first_number(_text_after_label(text, "THC:", 20))
    cbd = _first_number(_text_after_label(text, "CBD:", 20))

    manufacturer = _text_after_label(text, "Producent:", 80)
    if manufacturer:
        manufacturer = manufacturer.split("\n")[0].strip()

    genetics = _text_after_label(text, "Genetyka:", 80)
    if genetics:
        genetics = genetics.split("\n")[0].strip()

    packaging = _text_after_label(text, "Opakowanie:", 40)
    if packaging:
        packaging = packaging.split("\n")[0].strip()

    availability = _text_after_label(text, "Dostępność:", 40)
    if availability:
        availability = availability.split("\n")[0].strip()

    # Aroma tags: between "Profil zapachowy" and "Możliwe działanie"
    aroma_tags = []
    m = re.search(r"Profil zapachowy\n(.*?)\nMożliwe działanie", text, re.S)
    if m:
        aroma_tags = [t.strip() for t in m.group(1).split(",") if t.strip()]

    possible_effect = None
    m = re.search(r"Możliwe działanie\n([^\n]+)", text)
    if m:
        possible_effect = m.group(1).strip()

    # Dominant terpenes: "<Name> – udział w profilu terpenowym: NN%"
    dominant_terpenes = re.findall(
        r"([A-ZŁŚŻŹĆŃÓĄĘ][a-ząćęłńóśźż]+)\s*[–-]\s*udział w profilu terpenowym", text
    )
    dominant_terpenes = list(dict.fromkeys(dominant_terpenes))  # de-dupe, keep order

    country_growth = _text_after_label(text, "Kraj uprawy:", 40)
    if country_growth:
        country_growth = country_growth.split("\n")[0].strip()

    country_packaging = _text_after_label(text, "Kraj pakowania:", 40)
    if country_packaging:
        country_packaging = country_packaging.split("\n")[0].strip()

    parents = _text_after_label(text, "Rodzice:", 120)
    if parents:
        parents = parents.split("\n")[0].strip()

    # Description: paragraph(s) right after the "Opis" heading
    description = None
    m = re.search(r"\nOpis\n(.*?)\n(?:Profil zapachowy|Możliwe działanie|Podstawowe informacje)", text, re.S)
    if m:
        description = re.sub(r"\s+", " ", m.group(1)).strip()

    image_url = None
    og_img = soup.find("meta", property="og:image")
    if og_img:
        image_url = og_img["content"]

    slug = url.rstrip("/").split("/")[-1]

    return {
        "slug": slug,
        "source_url": url,
        "name": name,
        "manufacturer": manufacturer,
        "genetics": genetics,
        "thc_percent": thc,
        "cbd_percent": cbd,
        "availability": availability,
        "packaging": packaging,
        "aroma_tags": aroma_tags,
        "possible_effect": possible_effect,
        "dominant_terpenes": dominant_terpenes,
        "country_growth": country_growth,
        "country_packaging": country_packaging,
        "parents": parents,
        "description": description,
        "image_url": image_url,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="only scrape the first N strains (for testing)")
    ap.add_argument("--out", default="strains.json", help="output JSON file")
    args = ap.parse_args()

    print("Collecting strain URLs from the archive…")
    urls = collect_strain_urls()
    print(f"Found {len(urls)} strains in the catalog.")

    if args.limit:
        urls = urls[: args.limit]

    results = []
    for i, url in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] scraping {url}")
        try:
            data = parse_strain_page(url)
            results.append(data)
        except Exception as e:
            print(f"  !! failed: {e}")
        time.sleep(DELAY)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\nDone. Wrote {len(results)} strains to {args.out}")


if __name__ == "__main__":
    main()
