# Ziolo

Your personal web app for tracking medical cannabis strains available in Poland
(catalog pulled from [budcare.pl](https://budcare.pl)) — mark strains as tested,
rate taste/smell/look/power/experience (1–5), tag a global tier
(reggie/mid/top), and log price + vendor. Free to host, installable on your
iPhone home screen like a real app.

**Stack:** plain HTML/CSS/JS (no build step) + [Supabase](https://supabase.com)
(free Postgres database) + GitHub Pages (free static hosting).

---

## 1. Create your free Supabase project

1. Go to [supabase.com](https://supabase.com) → sign up (free tier is plenty for this).
2. **New project** → pick any name/region, set a database password (save it somewhere).
3. Once it's created, open **SQL Editor** → **New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. This creates
   the `strains` and `ratings` tables.
4. Go to **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://xxxxxxxx.supabase.co`)
   - **anon public** key (a long JWT string)

## 2. Load the strain catalog

You have two options — do either, or both (seed now, full scrape later):

**Option A — quick start with the seed data (6 real strains, already scraped for you)**

In the Supabase dashboard: **Table Editor → strains → Insert → Import data from CSV/JSON**,
or simply run the import script:

```bash
cd scraper
pip install requests --break-system-packages
python3 import_to_supabase.py --url https://YOUR-PROJECT.supabase.co --key YOUR_ANON_KEY --file seed_strains.json
```

**Option B — scrape the full catalog (~120+ strains) yourself**

The scraper needs to run somewhere with normal internet access (your laptop —
not this chat, which is sandboxed):

```bash
cd scraper
pip install requests beautifulsoup4 --break-system-packages
python3 scrape_budcare.py               # takes a few minutes, writes strains.json
python3 import_to_supabase.py --url https://YOUR-PROJECT.supabase.co --key YOUR_ANON_KEY --file strains.json
```

Re-run both commands any time you want to refresh the catalog with new
deliveries from budcare.pl — the import is safe to re-run, it just updates
existing rows (matched by `slug`) and adds new ones.

## 3. Configure the app

Open `config.js` and paste in your Supabase URL and anon key:

```js
window.ZIOLO_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
```

## 4. Put it on GitHub Pages (free hosting)

1. Create a new **public** GitHub repo (e.g. `ziolo`).
2. Upload everything in this folder (`index.html`, `app.js`, `styles.css`,
   `config.js`, `manifest.json`, `icons/`) to the repo root.
3. In the repo: **Settings → Pages → Source: Deploy from a branch → Branch: main /(root)**.
4. Wait a minute, then your app is live at:
   `https://YOUR-GITHUB-USERNAME.github.io/ziolo/`

## 5. Add it to your iPhone home screen

1. Open the GitHub Pages URL in **Safari** on your iPhone.
2. Tap the **Share** button → **Add to Home Screen**.
3. It now opens full-screen, no browser chrome — just like a real app.

---

## Notes & honest caveats

- **No login system.** This is a single-user personal tracker. The Supabase
  anon key is public in your JS (that's normal for Supabase's design), and the
  database policies are wide open (anyone with your GitHub Pages link could
  read/write your ratings). That's fine as long as you don't share the link
  widely. If you want real protection later, add Supabase Auth (email/password)
  — ask me and I can wire that in.
- **The catalog is a snapshot, not live.** Nothing re-scrapes budcare.pl
  automatically. Re-run the scraper + import whenever you want fresh data
  (new deliveries, price/availability changes, etc).
- **"Add your own strain"** button in the app lets you add anything the
  scraper missed (or a strain from a different source) directly from your phone.
- THC/CBD/genetics/etc. parsing is done via text-pattern matching on the
  Polish labels budcare.pl uses. If a page's exact wording is unusual, a field
  might come through empty — you can always fill it in by hand later (or
  extend `scraper/scrape_budcare.py`).

## File map

```
index.html                  the app shell
styles.css                  the "apothecary specimen card" design
app.js                      all the app logic (Supabase reads/writes, filtering, forms)
config.js                   ← put your Supabase URL/key here
manifest.json               iOS/PWA home-screen metadata
icons/                      home-screen icons
supabase/schema.sql         run once in Supabase SQL editor
scraper/scrape_budcare.py   pulls the full catalog from budcare.pl → strains.json
scraper/import_to_supabase.py   pushes a JSON file into your Supabase strains table
scraper/seed_strains.json   6 real strains, already scraped, ready to import
```
