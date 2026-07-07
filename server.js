const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { Parser } = require("json2csv");
const { chromium } = require("playwright");

// ============================================================
// COUNTRY / PHONE CODE HELPERS
// ============================================================

const CALLING_CODES = [
  { code: "1", country: "United States" },
  { code: "44", country: "United Kingdom" },
  { code: "91", country: "India" },
  { code: "234", country: "Nigeria" },
  { code: "233", country: "Ghana" },
  { code: "254", country: "Kenya" },
  { code: "27", country: "South Africa" },
  { code: "20", country: "Egypt" },
  { code: "212", country: "Morocco" },
  { code: "216", country: "Tunisia" },
  { code: "213", country: "Algeria" },
  { code: "86", country: "China" },
  { code: "81", country: "Japan" },
  { code: "82", country: "South Korea" },
  { code: "65", country: "Singapore" },
  { code: "60", country: "Malaysia" },
  { code: "62", country: "Indonesia" },
  { code: "63", country: "Philippines" },
  { code: "66", country: "Thailand" },
  { code: "84", country: "Vietnam" },
  { code: "92", country: "Pakistan" },
  { code: "880", country: "Bangladesh" },
  { code: "94", country: "Sri Lanka" },
  { code: "971", country: "United Arab Emirates" },
  { code: "966", country: "Saudi Arabia" },
  { code: "974", country: "Qatar" },
  { code: "961", country: "Lebanon" },
  { code: "962", country: "Jordan" },
  { code: "972", country: "Israel" },
  { code: "90", country: "Turkey" },
  { code: "49", country: "Germany" },
  { code: "33", country: "France" },
  { code: "39", country: "Italy" },
  { code: "34", country: "Spain" },
  { code: "351", country: "Portugal" },
  { code: "31", country: "Netherlands" },
  { code: "32", country: "Belgium" },
  { code: "41", country: "Switzerland" },
  { code: "43", country: "Austria" },
  { code: "46", country: "Sweden" },
  { code: "47", country: "Norway" },
  { code: "45", country: "Denmark" },
  { code: "358", country: "Finland" },
  { code: "48", country: "Poland" },
  { code: "420", country: "Czech Republic" },
  { code: "36", country: "Hungary" },
  { code: "30", country: "Greece" },
  { code: "353", country: "Ireland" },
  { code: "7", country: "Russia" },
  { code: "380", country: "Ukraine" },
  { code: "55", country: "Brazil" },
  { code: "52", country: "Mexico" },
  { code: "54", country: "Argentina" },
  { code: "56", country: "Chile" },
  { code: "57", country: "Colombia" },
  { code: "51", country: "Peru" },
  { code: "58", country: "Venezuela" },
  { code: "61", country: "Australia" },
  { code: "64", country: "New Zealand" },
];

const SORTED_CODES = [...CALLING_CODES].sort((a, b) => b.code.length - a.code.length);

function countryFromPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  const stripped = digits.replace(/^\+/, "");
  for (const entry of SORTED_CODES) {
    if (stripped.startsWith(entry.code)) return entry.country;
  }
  return null;
}

function addressMatchesCountry(addressText, targetCountry) {
  if (!addressText || !targetCountry) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  return norm(addressText).includes(norm(targetCountry));
}

// ============================================================
// QUERY EXPANSION (maximize discovery breadth)
// ============================================================

const PREFIXES = ["best", "top", "free", "new", "official", "the", "my", "easy", "simple"];
const SUFFIXES = [
  "app", "apps", "pro", "plus", "online", "2024", "2025", "2026",
  "free", "premium", "lite", "for android", "checker", "portal",
  "result", "results", "tool", "hub", "manager", "helper",
];

const GENERIC_CATEGORY_HINTS = {
  game: ["puzzle", "arcade", "action", "racing", "strategy", "rpg", "casual", "multiplayer"],
  waec: ["waec result", "waec checker", "waec past questions", "neco", "jamb", "cbt practice"],
  vtu: ["recharge", "data plan", "airtime", "bills payment", "subscription"],
  fashion: ["style", "outfit", "clothing", "boutique", "wardrobe", "shopping"],
};

function expandKeyword(keyword) {
  const base = keyword.trim().toLowerCase();
  const queries = new Set();
  queries.add(base);
  for (const p of PREFIXES) queries.add(`${p} ${base}`);
  for (const s of SUFFIXES) queries.add(`${base} ${s}`);
  for (const [key, hints] of Object.entries(GENERIC_CATEGORY_HINTS)) {
    if (base.includes(key)) {
      for (const h of hints) {
        queries.add(`${base} ${h}`);
        queries.add(`${h} ${base}`);
      }
    }
  }
  // Cap total queries so discovery finishes in a reasonable time. Each query
  // costs several seconds (page load + scroll), so keep this list lean -
  // breadth comes from combining search + category/collection crawling, not
  // from exhaustively enumerating every possible phrase.
  return Array.from(queries).slice(0, 25);
}

const CATEGORY_IDS = {
  "game apps": "GAME",
  games: "GAME",
  "action games": "GAME_ACTION",
  "puzzle games": "GAME_PUZZLE",
  finance: "FINANCE",
  fintech: "FINANCE",
  education: "EDUCATION",
  productivity: "PRODUCTIVITY",
  shopping: "SHOPPING",
  fashion: "LIFESTYLE",
  lifestyle: "LIFESTYLE",
  business: "BUSINESS",
  tools: "TOOLS",
  social: "SOCIAL",
  communication: "COMMUNICATION",
  entertainment: "ENTERTAINMENT",
  health: "MEDICAL",
  travel: "TRAVEL_AND_LOCAL",
  news: "NEWS_AND_MAGAZINES",
  music: "MUSIC_AND_AUDIO",
};

const COLLECTIONS = ["topselling_free", "topselling_paid", "topgrossing", "movers_shakers"];

function matchCategoryId(keyword) {
  const base = keyword.trim().toLowerCase();
  for (const [key, id] of Object.entries(CATEGORY_IDS)) {
    if (base.includes(key)) return id;
  }
  return null;
}

// ============================================================
// SCRAPER
// ============================================================

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+\d{1,3}[\s.-]?)?(\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/g;

const DOWNLOAD_BUCKETS = [
  { label: "less than 1K", min: 0, max: 999 },
  { label: "1K-10K", min: 1000, max: 9999 },
  { label: "10K-50K", min: 10000, max: 49999 },
  { label: "50K-100K", min: 50000, max: 99999 },
  { label: "100K-1M", min: 100000, max: 999999 },
];

function parseInstallsToNumber(text) {
  if (!text) return null;
  const cleaned = text.replace(/,/g, "").toLowerCase();
  const mMatch = cleaned.match(/([\d.]+)\s*m\+?/);
  if (mMatch) return parseFloat(mMatch[1]) * 1_000_000;
  const kMatch = cleaned.match(/([\d.]+)\s*k\+?/);
  if (kMatch) return parseFloat(kMatch[1]) * 1_000;
  const plain = cleaned.match(/(\d+)\+?/);
  if (plain) return parseInt(plain[1], 10);
  return null;
}

function bucketForInstalls(num) {
  if (num === null || num === undefined) return "unknown";
  const b = DOWNLOAD_BUCKETS.find((b) => num >= b.min && num <= b.max);
  return b ? b.label : num > 999999 ? "1M+" : "unknown";
}

function extractYear(text) {
  if (!text) return null;
  const m = text.match(/\b(20\d{2}|19\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

class PlayStoreScraper {
  constructor({ headless = true, gl = "us", hl = "en", concurrency = 3, delayMs = 350 } = {}) {
    this.headless = headless;
    this.gl = gl;
    this.hl = hl;
    this.concurrency = concurrency;
    this.delayMs = delayMs;
    this.browser = null;
  }

  async init() {
    if (!this.browser) {
      try {
        this.browser = await chromium.launch({
          headless: this.headless,
          args: ["--disable-blink-features=AutomationControlled"],
        });
      } catch (err) {
        throw new Error(
          `Chromium failed to launch (${err.message}). This usually means the deploy is missing Chromium's system dependencies - check that Railway built from the Dockerfile (Microsoft Playwright base image), not Nixpacks.`
        );
      }
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async newPage() {
    const context = await this.browser.newContext({
      locale: this.hl,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    const page = await context.newPage();
    return { context, page };
  }

  async sleep(ms) {
    return new Promise((res) => setTimeout(res, ms || this.delayMs));
  }

  async dismissConsent(page) {
    const consentSelectors = [
      'button:has-text("Accept all")',
      'button:has-text("I agree")',
      'button:has-text("Accept")',
      'form[action*="consent"] button',
      '#L2AGLb', // Google's common "I agree" button id
    ];
    for (const sel of consentSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click({ timeout: 2000 }).catch(() => {});
          await this.sleep(400);
          return true;
        }
      } catch (_) {
        /* ignore */
      }
    }
    return false;
  }

  async searchQuery(query, { maxScrolls = 4 } = {}) {
    const { context, page } = await this.newPage();
    const results = [];
    let debug = {};
    try {
      const url = `https://play.google.com/store/search?q=${encodeURIComponent(
        query
      )}&c=apps&gl=${this.gl}&hl=${this.hl}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await this.sleep(300);

      await this.dismissConsent(page);
      await this.sleep(300);

      for (let i = 0; i < maxScrolls; i++) {
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
        await this.sleep(400);
      }

      const links = await page.$$eval('a[href*="/store/apps/details?id="]', (as) =>
        as.map((a) => {
          const href = a.getAttribute("href") || "";
          const idMatch = href.match(/id=([a-zA-Z0-9._]+)/);
          const title = a.getAttribute("aria-label") || a.textContent || "";
          return { appId: idMatch ? idMatch[1] : null, title: title.trim() };
        })
      );

      for (const l of links) {
        if (l.appId) results.push(l);
      }

      debug = {
        pageTitle: await page.title().catch(() => null),
        finalUrl: page.url(),
        linksFound: links.length,
        bodySnippet: await page
          .evaluate(() => document.body.innerText.slice(0, 300))
          .catch(() => null),
      };
    } catch (err) {
      console.error(`searchQuery failed for "${query}":`, err.message);
      debug = { error: err.message };
    } finally {
      await context.close();
    }
    return { results, debug };
  }

  async crawlCategory(categoryId, collection, { maxScrolls = 8 } = {}) {
    const { context, page } = await this.newPage();
    const results = [];
    try {
      const url = `https://play.google.com/store/apps/category/${categoryId}/collection/${collection}?gl=${this.gl}&hl=${this.hl}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await this.sleep(500);
      await this.dismissConsent(page);
      await this.sleep(400);

      for (let i = 0; i < maxScrolls; i++) {
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
        await this.sleep(600);
      }

      const links = await page.$$eval('a[href*="/store/apps/details?id="]', (as) =>
        as.map((a) => {
          const href = a.getAttribute("href") || "";
          const idMatch = href.match(/id=([a-zA-Z0-9._]+)/);
          const title = a.getAttribute("aria-label") || a.textContent || "";
          return { appId: idMatch ? idMatch[1] : null, title: title.trim() };
        })
      );

      for (const l of links) {
        if (l.appId) results.push(l);
      }
    } catch (err) {
      console.error(`crawlCategory failed for ${categoryId}/${collection}:`, err.message);
    } finally {
      await context.close();
    }
    return results;
  }

  async getAppDetails(appId) {
    const { context, page } = await this.newPage();
    try {
      const url = `https://play.google.com/store/apps/details?id=${appId}&gl=${this.gl}&hl=${this.hl}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.sleep(400);

      const possibleButtons = [
        "text=App support",
        "text=About the developer",
        "text=Developer contact",
        "text=See more",
      ];
      for (const sel of possibleButtons) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click({ timeout: 2000 }).catch(() => {});
            await this.sleep(300);
          }
        } catch (_) {
          /* ignore */
        }
      }

      const bodyText = await page.evaluate(() => document.body.innerText);

      const title = await page.$eval("h1", (el) => el.textContent.trim()).catch(() => null);

      const developer = await page
        .$eval('a[href*="/store/apps/dev?id="], a[href*="/store/apps/developer?id="]', (el) =>
          el.textContent.trim()
        )
        .catch(() => null);

      const category = await page
        .$eval('a[href*="/store/apps/category/"]', (el) => el.textContent.trim())
        .catch(() => null);

      let installsText = null;
      const installsMatch = bodyText.match(/([\d.,]+[MK]?\+?)\s*\n?Downloads/i);
      if (installsMatch) installsText = installsMatch[1];

      let releaseText = null;
      const releaseMatch = bodyText.match(/Released on\s*\n?\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/);
      if (releaseMatch) releaseText = releaseMatch[1];

      const emails = Array.from(new Set((bodyText.match(EMAIL_RE) || []).map((e) => e.trim())));
      const phoneCandidates = bodyText.match(PHONE_RE) || [];
      const phones = Array.from(
        new Set(phoneCandidates.map((p) => p.trim()).filter((p) => p.replace(/\D/g, "").length >= 7))
      );

      let addressGuess = null;
      const addressBlockMatch = bodyText.match(/Address\s*\n([^\n]+(\n[^\n]+){0,3})/);
      if (addressBlockMatch) addressGuess = addressBlockMatch[1];

      const installsNum = parseInstallsToNumber(installsText);

      return {
        appId,
        title,
        developer,
        category,
        installsText,
        installsNum,
        downloadBucket: bucketForInstalls(installsNum),
        releaseText,
        releaseYear: extractYear(releaseText),
        emails,
        phones,
        addressGuess,
        phoneCountryGuesses: phones.map((p) => countryFromPhone(p)).filter(Boolean),
        url,
      };
    } catch (err) {
      console.error(`getAppDetails failed for ${appId}:`, err.message);
      return { appId, error: err.message };
    } finally {
      await context.close();
    }
  }

  async discoverApps(keyword, { includeCategoryCrawl = true, onUpdate } = {}) {
    const queries = expandKeyword(keyword);
    const foundMap = new Map();
    this.debugSamples = [];
    let queriesRun = 0;

    const emitUpdate = () => {
      if (onUpdate) {
        onUpdate({
          discovered: foundMap.size,
          debugSamples: this.debugSamples,
          queriesRun,
          queriesTotal: queries.length,
        });
      }
    };

    const runQuery = async (q) => {
      const { results: res, debug } = await this.searchQuery(q);
      queriesRun++;
      if (this.debugSamples.length < 5) {
        this.debugSamples.push({ query: q, ...debug });
      }
      for (const r of res) {
        if (!foundMap.has(r.appId)) foundMap.set(r.appId, r);
      }
      emitUpdate();
      await this.sleep();
    };

    let idx = 0;
    const workers = Array.from({ length: this.concurrency }).map(async () => {
      while (idx < queries.length) {
        const q = queries[idx++];
        await runQuery(q);
      }
    });
    await Promise.all(workers);

    if (includeCategoryCrawl) {
      const categoryId = matchCategoryId(keyword);
      if (categoryId) {
        for (const collection of COLLECTIONS) {
          const res = await this.crawlCategory(categoryId, collection);
          for (const r of res) {
            if (!foundMap.has(r.appId)) foundMap.set(r.appId, r);
          }
          emitUpdate();
          await this.sleep();
        }
      }
    }

    return Array.from(foundMap.values());
  }

  async enrichApps(appList, { onProgress } = {}) {
    const results = [];
    let idx = 0;
    const workers = Array.from({ length: this.concurrency }).map(async () => {
      while (idx < appList.length) {
        const app = appList[idx++];
        const details = await this.getAppDetails(app.appId);
        results.push({ ...app, ...details });
        if (onProgress) onProgress(results.length, appList.length);
        await this.sleep();
      }
    });
    await Promise.all(workers);
    return results;
  }
}

// ============================================================
// FILTERS
// ============================================================

function applyFilters(apps, filters = {}) {
  return apps.filter((app) => {
    if (filters.downloadBucket && app.downloadBucket !== filters.downloadBucket) return false;

    if (filters.yearFrom && (!app.releaseYear || app.releaseYear < filters.yearFrom)) return false;
    if (filters.yearTo && (!app.releaseYear || app.releaseYear > filters.yearTo)) return false;

    if (filters.country) {
      const addressHit = addressMatchesCountry(app.addressGuess, filters.country);
      const phoneHit = (app.phoneCountryGuesses || []).some(
        (c) => c && c.toLowerCase() === filters.country.toLowerCase()
      );
      if (!addressHit && !phoneHit) return false;
    }

    if (filters.state) {
      const stateHit =
        app.addressGuess && app.addressGuess.toLowerCase().includes(filters.state.toLowerCase());
      if (!stateHit) return false;
    }

    return true;
  });
}

// ============================================================
// EXPRESS SERVER
// ============================================================

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const jobs = new Map();

function createJob() {
  const id = uuidv4();
  jobs.set(id, {
    id,
    status: "pending",
    progress: { discovered: 0, enriched: 0, total: 0, queriesRun: 0, queriesTotal: 0 },
    results: [],
    error: null,
    debug: null,
    createdAt: Date.now(),
  });
  return id;
}

async function runJob(jobId, params) {
  const job = jobs.get(jobId);
  const scraper = new PlayStoreScraper({
    headless: true,
    gl: (params.countryCode || "us").toLowerCase(),
    concurrency: 3,
  });

  try {
    await scraper.init();

    job.status = "discovering";
    const discovered = await scraper.discoverApps(params.keyword, {
      includeCategoryCrawl: true,
      onUpdate: ({ discovered, debugSamples, queriesRun, queriesTotal }) => {
        job.progress.discovered = discovered;
        job.progress.total = discovered;
        job.progress.queriesRun = queriesRun;
        job.progress.queriesTotal = queriesTotal;
        job.debug = debugSamples;
      },
    });
    job.progress.discovered = discovered.length;
    job.progress.total = discovered.length;
    job.debug = scraper.debugSamples || null;

    job.status = "enriching";
    const enriched = await scraper.enrichApps(discovered, {
      onProgress: (done, total) => {
        job.progress.enriched = done;
        job.progress.total = total;
      },
    });

    job.status = "filtering";
    const filtered = applyFilters(enriched, {
      country: params.country || null,
      state: params.state || null,
      downloadBucket: params.downloadBucket || null,
      yearFrom: params.yearFrom || null,
      yearTo: params.yearTo || null,
    });

    job.results = filtered;
    job.status = "done";
  } catch (err) {
    console.error("Job failed:", err);
    job.status = "error";
    job.error = err.message;
  } finally {
    await scraper.close();
  }
}

app.post("/api/scrape", (req, res) => {
  const { keyword, country, state, downloadBucket, yearFrom, yearTo, countryCode } = req.body;

  if (!keyword || !keyword.trim()) {
    return res.status(400).json({ error: "keyword is required" });
  }

  const jobId = createJob();
  runJob(jobId, {
    keyword,
    country,
    state,
    downloadBucket,
    yearFrom: yearFrom ? parseInt(yearFrom, 10) : null,
    yearTo: yearTo ? parseInt(yearTo, 10) : null,
    countryCode,
  });

  res.json({ jobId });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    resultCount: job.results.length,
    debug: job.debug,
  });
});

app.get("/api/jobs/:id/results", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (job.status !== "done") {
    return res.status(409).json({ error: `job not finished (status: ${job.status})` });
  }
  res.json({ results: job.results });
});

app.get("/api/jobs/:id/csv", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("job not found");
  if (job.status !== "done") {
    return res.status(409).send(`job not finished (status: ${job.status})`);
  }

  const fields = [
    "appId", "title", "developer", "category", "installsText", "downloadBucket",
    "releaseText", "releaseYear", "emails", "phones", "phoneCountryGuesses",
    "addressGuess", "url",
  ];

  const rows = job.results.map((r) => ({
    ...r,
    emails: (r.emails || []).join("; "),
    phones: (r.phones || []).join("; "),
    phoneCountryGuesses: (r.phoneCountryGuesses || []).join("; "),
  }));

  const parser = new Parser({ fields });
  const csv = parser.parse(rows);

  res.header("Content-Type", "text/csv");
  res.attachment(`playstore-results-${job.id}.csv`);
  res.send(csv);
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ============================================================
// FRONTEND (inline - no /public folder needed)
// ============================================================

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Play Store Discovery Scraper</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1115;
    color: #e6e6e6;
    margin: 0;
    padding: 16px;
  }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.sub { color: #9aa0a6; font-size: 13px; margin-top: 0; margin-bottom: 20px; }
  label { display: block; margin-top: 14px; font-size: 13px; color: #c7c7c7; }
  input, select {
    width: 100%;
    padding: 10px;
    margin-top: 4px;
    border-radius: 8px;
    border: 1px solid #2a2d35;
    background: #1a1d24;
    color: #fff;
    font-size: 15px;
  }
  button {
    margin-top: 20px;
    width: 100%;
    padding: 14px;
    border-radius: 8px;
    border: none;
    background: #4f8cff;
    color: #fff;
    font-size: 16px;
    font-weight: 600;
  }
  button:disabled { background: #3a3f4b; }
  #status {
    margin-top: 16px;
    font-size: 14px;
    color: #9aa0a6;
    white-space: pre-line;
  }
  #results { margin-top: 20px; }
  .row {
    border: 1px solid #2a2d35;
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .row b { color: #fff; }
  .muted { color: #9aa0a6; }
  a.dl {
    display: inline-block;
    margin-top: 14px;
    color: #4f8cff;
    text-decoration: none;
    font-size: 14px;
  }
</style>
</head>
<body>
  <h1>Play Store Discovery Scraper</h1>
  <p class="sub">Search by keyword or category, narrow down by country, download range, and release year. Extracts developer email/phone from each listing's "About the developer" info.</p>

  <label>Keyword or category</label>
  <input id="keyword" placeholder="e.g. waec apps, vtu apps, fashion apps" />

  <label>Filter country (matched against developer address / phone code)</label>
  <input id="country" placeholder="e.g. Nigeria" />

  <label>State / region (optional, matched against developer address text)</label>
  <input id="state" placeholder="e.g. Lagos" />

  <label>Play Store storefront country (affects what search results Play returns)</label>
  <select id="countryCode">
    <option value="us">United States</option>
    <option value="ng">Nigeria</option>
    <option value="gb">United Kingdom</option>
    <option value="in">India</option>
    <option value="ke">Kenya</option>
    <option value="gh">Ghana</option>
    <option value="za">South Africa</option>
  </select>

  <label>Download range</label>
  <select id="downloadBucket">
    <option value="">Any</option>
    <option value="100K-1M">100K - 1M</option>
    <option value="50K-100K">50K - 100K</option>
    <option value="10K-50K">10K - 50K</option>
    <option value="1K-10K">1K - 10K</option>
    <option value="less than 1K">Less than 1K</option>
  </select>

  <label>Release year from</label>
  <input id="yearFrom" type="number" placeholder="e.g. 2020" />

  <label>Release year to</label>
  <input id="yearTo" type="number" placeholder="e.g. 2026" />

  <button id="startBtn">Start Scrape</button>

  <div id="status"></div>
  <div id="results"></div>

  <script>
    const startBtn = document.getElementById("startBtn");
    const statusEl = document.getElementById("status");
    const resultsEl = document.getElementById("results");
    let pollTimer = null;

    startBtn.addEventListener("click", async () => {
      const keyword = document.getElementById("keyword").value.trim();
      if (!keyword) { alert("Enter a keyword or category first."); return; }

      const body = {
        keyword,
        country: document.getElementById("country").value.trim(),
        state: document.getElementById("state").value.trim(),
        countryCode: document.getElementById("countryCode").value,
        downloadBucket: document.getElementById("downloadBucket").value,
        yearFrom: document.getElementById("yearFrom").value,
        yearTo: document.getElementById("yearTo").value,
      };

      startBtn.disabled = true;
      resultsEl.innerHTML = "";
      statusEl.textContent = "Starting job...";

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const res = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const data = await res.json();
        if (!res.ok) {
          statusEl.textContent = "Error: " + (data.error || "unknown");
          startBtn.disabled = false;
          return;
        }

        statusEl.textContent = "Job started (" + data.jobId + "). Waiting for progress...";
        pollTimer = setInterval(() => pollJob(data.jobId), 2000);
      } catch (err) {
        startBtn.disabled = false;
        if (err.name === "AbortError") {
          statusEl.textContent = "Request timed out after 15s - the server likely isn't responding. Check Railway deploy logs.";
        } else {
          statusEl.textContent = "Request failed: " + err.message;
        }
      }
    });

    async function pollJob(jobId) {
      const res = await fetch("/api/jobs/" + jobId);
      const data = await res.json();

      statusEl.textContent =
        "Status: " + data.status + "\\n" +
        (data.progress.queriesTotal
          ? "Search queries run: " + (data.progress.queriesRun || 0) + " / " + data.progress.queriesTotal + "\\n"
          : "") +
        "Discovered: " + data.progress.discovered + "\\n" +
        "Enriched: " + data.progress.enriched + " / " + data.progress.total;

      if (data.debug && data.debug.length) {
        statusEl.textContent += "\\n\\nDebug (first search attempts):\\n";
        data.debug.forEach((d, i) => {
          statusEl.textContent +=
            "\\n[" + (i + 1) + "] query: " + d.query +
            "\\n  page title: " + (d.pageTitle || "-") +
            "\\n  final url: " + (d.finalUrl || "-") +
            "\\n  links found: " + (d.linksFound ?? "-") +
            (d.error ? "\\n  error: " + d.error : "") +
            (d.bodySnippet ? "\\n  body starts: " + d.bodySnippet.slice(0, 120) : "");
        });
      }

      if (data.status === "done") {
        clearInterval(pollTimer);
        startBtn.disabled = false;
        loadResults(jobId, data.resultCount);
      } else if (data.status === "error") {
        clearInterval(pollTimer);
        startBtn.disabled = false;
        statusEl.textContent += "\\nError: " + data.error;
      }
    }

    async function loadResults(jobId, count) {
      const res = await fetch("/api/jobs/" + jobId + "/results");
      const data = await res.json();

      resultsEl.innerHTML = '<a class="dl" href="/api/jobs/' + jobId + '/csv">Download CSV (' + count + ' results)</a>';

      for (const app of data.results.slice(0, 50)) {
        const div = document.createElement("div");
        div.className = "row";
        div.innerHTML =
          "<b>" + (app.title || app.appId) + "</b><br/>" +
          '<span class="muted">' + (app.developer || "-") + " · " + (app.category || "-") + " · " + (app.downloadBucket || "-") + " · " + (app.releaseYear || "-") + "</span><br/>" +
          "Emails: " + ((app.emails || []).join(", ") || "-") + "<br/>" +
          "Phones: " + ((app.phones || []).join(", ") || "-");
        resultsEl.appendChild(div);
      }
      if (data.results.length > 50) {
        const note = document.createElement("p");
        note.className = "muted";
        note.textContent = "Showing first 50 of " + data.results.length + ". Download the CSV for the full list.";
        resultsEl.appendChild(note);
      }
    }
  </script>
</body>
</html>`;

app.get("/", (req, res) => {
  res.send(HTML_PAGE);
});

app.listen(PORT, () => {
  console.log(`Play Store scraper listening on port ${PORT}`);
});
