// src/constants/pricing.js — canonical pricing table for Ghost Architect™.
//
// Single source of truth for tier prices and the free-trial offer. Every
// paywall renderer, README table, and CLI copy string that quotes a price
// should read it from here so a price change lands in one place instead of
// drifting across surfaces.
//
// Monthly and annual are in whole US dollars. TRIAL_DAYS / TRIAL_URL drive the
// "free 7-day Ghost Pro Max™ trial" call-to-action rendered in the paywalls.
//
// NOTE: this package is ESM ("type": "module" in package.json), so this module
// uses `export const`, not `module.exports`. The exported shape is a named
// `PRICING` export — import it with `import { PRICING } from './constants/pricing.js'`.

export const PRICING = {
  PRO: { monthly: 25, annual: 300 },
  PRO_MAX: { monthly: 99, annual: 1188 },
  TEAM: { monthly: 399, annual: 4788 },
  ENTERPRISE: { monthly: 1200, annual: 14400 },
  TRIAL_DAYS: 7,
  TRIAL_URL: 'https://ghostarchitect.dev/trial',
};
