// src/license/format.js
//
// Ghost-native human-typeable license key format.
//
// Surface shape:  GA-2026-PRO-X7K9-M2P4-Q8R3
//                 ^^ ^^^^ ^^^ ^^^^^^^^^^^^ checksum is last char
//                 |  |    |   `payload (12 chars, last is checksum)
//                 |  |    `tier (PRO/TEM/ENT)
//                 |  `year (4 digits)
//                 `brand prefix
//
// Payload uses Crockford-base32 minus visually-ambiguous chars (no IL0OU1).
// 11 payload data chars + 1 checksum char = 12 char payload total.
//
// The "license id" is the 11 data chars (we drop the checksum when looking
// up server-side; the checksum exists purely to catch typos before we make
// a network call).

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALPHABET_SET = new Set(ALPHABET.split(''));

const VALID_TIERS = new Set(['PRO', 'TEM', 'ENT']);

// Mod-32 checksum over the data chars. Each char maps to its index in the
// alphabet, sum mod 32 gives the checksum char.
function computeChecksum(dataChars) {
  let sum = 0;
  for (const c of dataChars) {
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid alphabet char: ${c}`);
    sum += idx;
  }
  return ALPHABET[sum % 32];
}

// Random 11-char data string from the safe alphabet, using crypto.randomBytes
// so we get cryptographically random license IDs (not Math.random).
import crypto from 'crypto';
function randomDataChars(n = 11) {
  // Rejection sampling so the distribution stays uniform across 32 symbols.
  const out = [];
  while (out.length < n) {
    const buf = crypto.randomBytes(n * 2);
    for (const b of buf) {
      if (out.length >= n) break;
      // Take the low 5 bits, discard anything that maps out of range — but
      // 32 evenly divides 256 so every byte is usable. Just mask low 5 bits.
      out.push(ALPHABET[b & 0x1f]);
    }
  }
  return out.join('');
}

// Build a fresh human key for a given tier and year.
export function generateKey(tier, year = new Date().getUTCFullYear()) {
  const tierCode = tier.toUpperCase();
  if (!VALID_TIERS.has(tierCode)) {
    throw new Error(`Invalid tier: ${tier} (must be one of ${[...VALID_TIERS].join(', ')})`);
  }
  if (!Number.isInteger(year) || year < 2026 || year > 2099) {
    throw new Error(`Invalid year: ${year}`);
  }
  const dataChars = randomDataChars(11);
  const checksum = computeChecksum(dataChars);
  const payload = dataChars + checksum;
  return `GA-${year}-${tierCode}-${payload.slice(0, 4)}-${payload.slice(4, 8)}-${payload.slice(8, 12)}`;
}

// Parse a human key string into its components. Throws on malformed input.
// Returns { brand, year, tier, licenseId, checksum, raw } where licenseId is
// the 11 data chars (no checksum) — that's what looks up server-side.
export function parseKey(input) {
  if (typeof input !== 'string') {
    throw new Error('License key must be a string');
  }
  // Normalize: uppercase, strip whitespace.
  const normalized = input.trim().toUpperCase().replace(/\s+/g, '');
  // Allow keys with or without hyphens for paste tolerance.
  const parts = normalized.split('-');
  if (parts.length !== 6) {
    throw new Error(`License key must have 6 hyphen-separated segments, got ${parts.length}`);
  }
  const [brand, yearStr, tier, p1, p2, p3] = parts;
  if (brand !== 'GA') {
    throw new Error(`License key must start with GA, got ${brand}`);
  }
  const year = parseInt(yearStr, 10);
  if (!/^\d{4}$/.test(yearStr) || year < 2026 || year > 2099) {
    throw new Error(`Invalid year segment: ${yearStr}`);
  }
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`Invalid tier segment: ${tier}`);
  }
  if (p1.length !== 4 || p2.length !== 4 || p3.length !== 4) {
    throw new Error(`Payload segments must each be 4 chars (got ${p1.length}/${p2.length}/${p3.length})`);
  }
  const payload = p1 + p2 + p3;
  for (const c of payload) {
    if (!ALPHABET_SET.has(c)) {
      throw new Error(`Invalid character in payload: ${c}`);
    }
  }
  const dataChars = payload.slice(0, 11);
  const checksumChar = payload.slice(11, 12);
  const expectedChecksum = computeChecksum(dataChars);
  if (checksumChar !== expectedChecksum) {
    throw new Error(`Checksum mismatch (likely typo). Got ${checksumChar}, expected ${expectedChecksum}.`);
  }
  return {
    brand,
    year,
    tier: tier.toLowerCase() === 'tem' ? 'team' : tier.toLowerCase(),
    licenseId: dataChars,
    checksum: checksumChar,
    raw: `${brand}-${yearStr}-${tier}-${p1}-${p2}-${p3}`,
  };
}

// Convenience: validate a key string without throwing. Returns
// { ok: true, parsed } or { ok: false, error }.
export function tryParseKey(input) {
  try {
    return { ok: true, parsed: parseKey(input) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Re-export alphabet for tests.
export const _ALPHABET = ALPHABET;
