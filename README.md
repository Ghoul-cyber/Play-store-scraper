# Play Store Discovery Scraper

Searches Google Play by keyword/category, filters by country, download range,
and release year, and extracts each app's published developer contact info
(email/phone from the "About the developer" section).

This version is a **flat structure on purpose** — everything backend-related
lives in one `server.js` (including the frontend HTML, served inline) so
there's no `lib/` or `public/` subfolder to worry about when uploading to
GitHub. Just these 5 files at the repo root: `package.json`, `Dockerfile`,
`railway.json`, `.gitignore`, `server.js`.

## What it does

- Expands one keyword into dozens of query variations + crawls matching
  category/collection pages, to surface far more apps than a single Play
  search UI query would show.
- Visits each app's detail page and pulls: title, developer, category,
  install-count range, release date/year, and any published developer email,
  phone, and address.
- Filters results by:
  - **Country** — matched against the developer's address text *or* the
    calling code of any phone number found.
  - **State/region** — matched against the address text.
  - **Download range** — bucketed from Play's own displayed ranges (100K-1M,
    50K-100K, 10K-50K, 1K-10K, <1K).
  - **Release year** — from/to range.
- Exports results as CSV (app name, developer, category, installs, release
  year, emails, phones, phone country guess, address, listing URL).

## What it does NOT do

No bulk WhatsApp/email sending. It collects publicly published contact info
only — sending is left entirely up to you, manually, respecting each
platform's terms and applicable anti-spam law in your jurisdiction.

## Known limitations (please read before relying on results)

- Google Play has no public bulk-search API. This scrapes the storefront
  pages directly, which is against Play's Terms of Service — Google can
  rate-limit or block the scraping IP if hit too hard. Concurrency and
  delays are conservative by default; tune `concurrency`/`delayMs` inside
  the `PlayStoreScraper` constructor call in `server.js` if you need to go
  slower.
- Play's DOM/selectors change periodically. Selectors in `server.js`
  use several fallbacks and regex-based text extraction, but if Google
  changes the page layout, extraction may need small updates.
- Not every developer publishes a phone number or full address — Play only
  requires an email at minimum. Expect gaps in phone/address data.
- "Thousands of results" depends entirely on how many apps actually exist
  for that keyword — this maximizes *discovery breadth*, it doesn't invent
  apps that aren't there.

## Local setup

```bash
npm install
npx playwright install --with-deps chromium
npm start
```

Visit `http://localhost:3000`.

## Deploying to Railway

1. Push this repo to GitHub.
2. In Railway, create a new project from the GitHub repo.
3. Railway will detect `railway.json` and build via the included
   `Dockerfile` (uses Microsoft's official Playwright image, so Chromium
   and its system dependencies are already included — no extra setup).
4. No environment variables are required to start. Railway sets `PORT`
   automatically; the app reads it via `process.env.PORT`.
5. Once deployed, open the Railway-provided URL — same UI as local.

## API (if you want to call it directly instead of the UI)

- `POST /api/scrape` — body: `{ keyword, country, state, countryCode, downloadBucket, yearFrom, yearTo }` → `{ jobId }`
- `GET /api/jobs/:id` — poll status/progress
- `GET /api/jobs/:id/results` — JSON results (once `status: "done"`)
- `GET /api/jobs/:id/csv` — CSV download (once `status: "done"`)

## Notes on scaling

Jobs are stored in memory, which is fine for a single Railway instance.
If you later run multiple replicas or want jobs to survive a restart,
swap the `jobs` Map in `server.js` for Redis or a database table.
