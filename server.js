const express = require("express");
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { Parser } = require("json2csv");

const { PlayStoreScraper } = require("./lib/scraper");
const { applyFilters } = require("./lib/filters");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// In-memory job store. Fine for single-instance Railway deploys; swap for
// Redis/Postgres if you scale to multiple replicas.
const jobs = new Map();

function createJob() {
  const id = uuidv4();
  jobs.set(id, {
    id,
    status: "pending", // pending | discovering | enriching | filtering | done | error
    progress: { discovered: 0, enriched: 0, total: 0 },
    results: [],
    error: null,
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
    });
    job.progress.discovered = discovered.length;
    job.progress.total = discovered.length;

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

// Start a new scrape job. Returns immediately with a jobId; poll /api/jobs/:id
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
    "appId",
    "title",
    "developer",
    "category",
    "installsText",
    "downloadBucket",
    "releaseText",
    "releaseYear",
    "emails",
    "phones",
    "phoneCountryGuesses",
    "addressGuess",
    "url",
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

app.listen(PORT, () => {
  console.log(`Play Store scraper listening on port ${PORT}`);
});
