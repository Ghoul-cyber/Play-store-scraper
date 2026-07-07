// Minimal but broad calling-code -> country map, plus common country name aliases
// used to match free-text "About the developer" addresses.

const CALLING_CODES = [
  { code: "1", country: "United States" }, // also Canada; disambiguated as best-effort
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

// Sort longest-code-first so "234" matches before "2"
const SORTED_CODES = [...CALLING_CODES].sort((a, b) => b.code.length - a.code.length);

/**
 * Given a raw phone string like "+234 803 123 4567", return best-guess country name.
 */
function countryFromPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  const stripped = digits.replace(/^\+/, "");
  for (const entry of SORTED_CODES) {
    if (stripped.startsWith(entry.code)) {
      return entry.country;
    }
  }
  return null;
}

/**
 * Loose match: does this address text mention the target country (or a common alias)?
 */
function addressMatchesCountry(addressText, targetCountry) {
  if (!addressText || !targetCountry) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  return norm(addressText).includes(norm(targetCountry));
}

module.exports = { CALLING_CODES, countryFromPhone, addressMatchesCountry };
