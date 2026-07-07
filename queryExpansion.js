// Play Store's own search UI caps out around ~24-50 visible results per query
// even though thousands of matching apps may exist. The way to surface more of
// them is to fan a single keyword out into many distinct queries and merge +
// dedupe the results by package id. This module builds that query set.

const PREFIXES = [
  "best", "top", "free", "new", "official", "the", "my", "easy", "simple",
];

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

  // If the keyword matches a known domain, pull in closely related terms too
  for (const [key, hints] of Object.entries(GENERIC_CATEGORY_HINTS)) {
    if (base.includes(key)) {
      for (const h of hints) {
        queries.add(`${base} ${h}`);
        queries.add(`${h} ${base}`);
      }
    }
  }

  // Alphabet-seeded variants catch long-tail apps that only surface once a
  // more specific string is searched (Play's autocomplete-style matching).
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    queries.add(`${base} ${letter}`);
  }

  return Array.from(queries);
}

// Play category IDs used for /store/apps/category/{ID} browsing crawl.
// Full canonical list: https://support.google.com/googleplay/android-developer/answer/113475
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

module.exports = { expandKeyword, matchCategoryId, CATEGORY_IDS, COLLECTIONS };
