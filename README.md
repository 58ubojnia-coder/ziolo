# Ziolo

Your personal web app for tracking medical cannabis strains available in Poland
(catalog pulled from [budcare.pl](https://budcare.pl)) — mark strains as tested,
rate taste/smell/look/power/experience (1–5), tag a global tier
(reggie/mid/top), and log price + vendor. Free to host, installable on your
iPhone home screen like a real app, and now supports multiple people each
with their own private ratings on a shared catalog.

**Stack:** plain HTML/CSS/JS (no build step) + [Supabase](https://supabase.com)
(free Postgres database + auth) + GitHub Pages (free static hosting).

---

## 1. Create your free Supabase project

1. Go to [supabase.com](https://supabase.com) → sign up (free tier is plenty for this).
2. **New project** → pick any name/region, set a database password (save it somewhere).
3. Once it's created, open **SQL Editor** → **New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. This creates
   the `strains` and `ratings` tables with the right permissions.
   - If you already ran an earlier version of this schema and don't have real
     data yet, run `drop table if exists ratings; drop table if exists strains;`
     first, then run the file.
4. Go to **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://xxxxxxxx.supabase.co`)
   - **anon public** key (a long JWT string — this goes in the app)
   - **service_role** key (a different long JWT string — keep this one secret,
     it's only used by the scraper's import script, never in the app itself)

## 2. Turn on email/password login for your friends

1. In Supabase: **Authentication → Providers → Email** — make sure it's enabled (it is by default).
2. Optional but recommended for a small friend group: **Authentication → Settings**
   (or **Providers → Email** depending on your project version) → turn **off**
   "Confirm email". This skips email verification so your friends can sign up
   and start using the app immediately instead of waiting on a confirmation
   email that might land in spam. If you leave it on, they'll get a
   confirmation email from Supabase after signing up and need to click it
   before logging in.
3. That's it — there's no separate "user database" to manage. Anyone who opens
   your app's URL can tap "Nie mam konta — zarejestruj mnie" and create their
   own account with an email + password. Everyone sees the same strain
   catalog, but each person's tested/tier/ratings/price/notes are private to
   them (enforced by row-level security in the schema, not just hidden in the UI).

## 3. Load the strain catalog

**Option A — quick start with the seed data (6 real strains, already scraped for you)**

```bash
cd scraper
pip install requests --break-system-packages
python3 import_to_supabase.py --url https://YOUR-PROJECT.supabase.co --key YOUR_SERVICE_ROLE_KEY --file seed_strains.json
```

**Option B — scrape the full catalog (~120+ strains) yourself**

The scraper needs to run somewhere with normal internet access (your laptop —
not this chat, which is sandboxed):

```bash
cd scraper
pip install requests beautifulsoup4 --break-system-packages
python3 scrape_budcare.py               # walks all archive pages, writes strains.json
python3 import_to_supabase.py --url https://YOUR-PROJECT.supabase.co --key YOUR_SERVICE_ROLE_KEY --file strains.json
```

Watch the terminal output — it prints a running total as it paginates through
the archive, so you can confirm it's picking up all ~120+ strains and not
stopping early. Re-run both commands any time you want to refresh the catalog.

**Important:** use the **service_role** key for both import commands, not the
anon key — the schema requires a signed-in session to write to `strains`
(RLS), and the service_role key bypasses that for this offline bulk step. See
the comment at the top of `scraper/import_to_supabase.py` for details. Never
put the service_role key in `config.js` or anywhere in the app's client code.

## 4. Configure the app

Open `config.js` and paste in your Supabase URL and **anon** key (not service_role):

```js
window.ZIOLO_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
```

## 5. Put it on GitHub Pages (free hosting)

1. Create a new **public** GitHub repo (e.g. `ziolo`).
2. Upload everything in this folder (`index.html`, `app.js`, `styles.css`,
   `config.js`, `manifest.json`, `icons/`) to the repo root.
3. In the repo: **Settings → Pages → Source: Deploy from a branch → Branch: main /(root)**.
4. Wait a minute, then your app is live at:
   `https://YOUR-GITHUB-USERNAME.github.io/ziolo/`
5. Send that link to your friends — they sign up with their own email/password
   right on the login screen.

## 6. Add it to your iPhone home screen

1. Open the GitHub Pages URL in **Safari** on your iPhone.
2. Tap the **Share** button → **Add to Home Screen**.
3. It now opens full-screen, no browser chrome — just like a real app.

---

## Troubleshooting

**Stuck on "Ładowanie katalogu…" forever:** open the browser console
(Safari: Settings → Advanced → Web Inspector, then connect to a Mac; or just
test in desktop Chrome first with F12) and look for a red error. The app now
surfaces real error messages in the UI too instead of hanging silently — if
you see a banner about Supabase not loading or a config error, it'll tell you
exactly what's wrong (usually: `config.js` still has the placeholder values,
or `schema.sql` wasn't run yet).

**Scraper only finds a handful of strains:** the archive at `/odmiany/` is
paginated (~13 pages). The scraper now walks pages until it hits one with no
results, printing a running total as it goes — watch the terminal output to
confirm it's climbing past page 1. `/baza-odmian/` is a JS-driven filter UI
backed by the same underlying catalog; it's not any more complete than
`/odmiany/`, just harder to scrape (needs a real browser to render), so this
scraper intentionally uses the archive instead.

## Notes & honest caveats

- **Shared catalog, private ratings.** Everyone who signs up sees the same
  scraped strain list, but tested/tier/price/vendor/ratings/notes are visible
  only to the person who entered them (enforced server-side via Postgres
  row-level security, so it's not just hidden in the UI — it's actually not
  queryable by other users' sessions).
- **Anyone can sign up.** There's no invite-only gate — whoever has the link
  can create an account. Fine for sharing with a friend group; if you want to
  lock it down further later (invite codes, admin approval), that's a
  reasonable next step to ask me about.
- **The catalog is a snapshot, not live.** Nothing re-scrapes budcare.pl
  automatically. Re-run the scraper + import whenever you want fresh data.
- **"Add your own strain"** button lets any signed-in user add something the
  scraper missed directly to the shared catalog.
- THC/CBD/genetics/etc. parsing is done via text-pattern matching on the
  Polish labels budcare.pl uses. If a page's wording is unusual, a field might
  come through empty — fill it in by hand, or extend `scraper/scrape_budcare.py`.

## File map

```
index.html                  app shell (login screen + main app)
styles.css                  the "apothecary specimen card" design
app.js                      auth, Supabase reads/writes, filtering, forms
config.js                   ← put your Supabase URL/anon key here
manifest.json               iOS/PWA home-screen metadata
icons/                      home-screen icons
supabase/schema.sql         run once in Supabase SQL editor (tables + auth policies)
scraper/scrape_budcare.py   pulls the full catalog from budcare.pl → strains.json
scraper/import_to_supabase.py   pushes a JSON file into your Supabase strains table (needs service_role key)
scraper/seed_strains.json   6 real strains, already scraped, ready to import
```
