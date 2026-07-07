const { addressMatchesCountry } = require("./countries");

/**
 * Apply user-selected filters to the enriched app list.
 * filters: {
 *   country: string|null,
 *   state: string|null,
 *   downloadBucket: string|null ("100K-1M" | "50K-100K" | "10K-50K" | "1K-10K" | "less than 1K"),
 *   yearFrom: number|null,
 *   yearTo: number|null
 * }
 */
function applyFilters(apps, filters = {}) {
  return apps.filter((app) => {
    if (filters.downloadBucket && app.downloadBucket !== filters.downloadBucket) {
      return false;
    }

    if (filters.yearFrom && (!app.releaseYear || app.releaseYear < filters.yearFrom)) {
      return false;
    }
    if (filters.yearTo && (!app.releaseYear || app.releaseYear > filters.yearTo)) {
      return false;
    }

    if (filters.country) {
      const addressHit = addressMatchesCountry(app.addressGuess, filters.country);
      const phoneHit = (app.phoneCountryGuesses || []).some(
        (c) => c && c.toLowerCase() === filters.country.toLowerCase()
      );
      if (!addressHit && !phoneHit) return false;
    }

    if (filters.state) {
      const stateHit =
        app.addressGuess &&
        app.addressGuess.toLowerCase().includes(filters.state.toLowerCase());
      if (!stateHit) return false;
    }

    return true;
  });
}

module.exports = { applyFilters };
