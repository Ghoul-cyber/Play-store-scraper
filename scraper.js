const { chromium } = require("playwright");
const { expandKeyword, matchCategoryId, COLLECTIONS } = require("./queryExpansion");
const { countryFromPhone, addressMatchesCountry } = require("./countries");

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
  // Play shows things like "10,000+", "500+", "1M+", "10 - 50 downloads" (older format)
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

  /**
   * Search Play Store for a single query string, scroll to load more results,
   * and return a list of { appId, title, developer } found on the results page.
   */
  async searchQuery(query, { maxScrolls = 6 } = {}) {
    const { context, page } = await this.newPage();
    const results = [];
    try {
      const url = `https://play.google.com/store/search?q=${encodeURIComponent(
        query
      )}&c=apps&gl=${this.gl}&hl=${this.hl}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.sleep(500);

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
      // Swallow per-query failures so one bad query doesn't kill the whole job
      console.error(`searchQuery failed for "${query}":`, err.message);
    } finally {
      await context.close();
    }
    return results;
  }

  /**
   * Crawl a Play Store category/collection listing page directly
   * (e.g. /store/apps/category/GAME) as an additional discovery source
   * beyond keyword search.
   */
  async crawlCategory(categoryId, collection, { maxScrolls = 8 } = {}) {
    const { context, page } = await this.newPage();
    const results = [];
    try {
      const url = `https://play.google.com/store/apps/category/${categoryId}/collection/${collection}?gl=${this.gl}&hl=${this.hl}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.sleep(500);

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

  /**
   * Visit a single app's detail page and extract everything we can:
   * install range, release date/year, and "About the developer" contact info
   * (email, phone, address) which Play requires developers to publish.
   */
  async getAppDetails(appId) {
    const { context, page } = await this.newPage();
    try {
      const url = `https://play.google.com/store/apps/details?id=${appId}&gl=${this.gl}&hl=${this.hl}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.sleep(400);

      // Try to open the "About this app" / developer info panel if present.
      // Play frequently changes exact button text/labels, so try a few.
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

      const title = await page
        .$eval("h1", (el) => el.textContent.trim())
        .catch(() => null);

      const developer = await page
        .$eval('a[href*="/store/apps/dev?id="], a[href*="/store/apps/developer?id="]', (el) =>
          el.textContent.trim()
        )
        .catch(() => null);

      const category = await page
        .$eval('a[href*="/store/apps/category/"]', (el) => el.textContent.trim())
        .catch(() => null);

      // Installs text appears near "downloads" / "Downloads" label
      let installsText = null;
      const installsMatch = bodyText.match(/([\d.,]+[MK]?\+?)\s*\n?Downloads/i);
      if (installsMatch) installsText = installsMatch[1];

      // Release date: Play shows "Released on <date>"
      let releaseText = null;
      const releaseMatch = bodyText.match(/Released on\s*\n?\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/);
      if (releaseMatch) releaseText = releaseMatch[1];

      const emails = Array.from(new Set((bodyText.match(EMAIL_RE) || []).map((e) => e.trim())));
      const phoneCandidates = bodyText.match(PHONE_RE) || [];
      const phones = Array.from(
        new Set(
          phoneCandidates
            .map((p) => p.trim())
            .filter((p) => p.replace(/\D/g, "").length >= 7)
        )
      );

      // Address block: grab the line(s) following "Developer" contact section if findable
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

  /**
   * Full discovery pipeline: expand the keyword into many queries, run them
   * (with limited concurrency), optionally crawl matching category/collection
   * pages, then dedupe by appId.
   */
  async discoverApps(keyword, { includeCategoryCrawl = true } = {}) {
    const queries = expandKeyword(keyword);
    const foundMap = new Map();

    const runQuery = async (q) => {
      const res = await this.searchQuery(q);
      for (const r of res) {
        if (!foundMap.has(r.appId)) foundMap.set(r.appId, r);
      }
      await this.sleep();
    };

    // Simple concurrency pool
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
          await this.sleep();
        }
      }
    }

    return Array.from(foundMap.values());
  }

  /**
   * Fetch details for a list of discovered apps, with limited concurrency.
   */
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

module.exports = { PlayStoreScraper, DOWNLOAD_BUCKETS, bucketForInstalls, addressMatchesCountry };
