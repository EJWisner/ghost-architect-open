// src/utils/rates.js
//
// Billing rates used in cost estimates. Rates come from the user's saved
// settings (ghost --reconfigure); any rate that is missing or not a finite
// number falls back to the built-in default.

const DEFAULT_RATES = { junior: 85, mid: 125, senior: 200 };

/**
 * Normalize saved rates into { junior, mid, senior }. Returns a new object;
 * the input is not mutated.
 *
 * @param {{junior?:number, mid?:number, senior?:number}|null|undefined} globalRates
 * @returns {{junior:number, mid:number, senior:number}}
 */
export function resolveRates(globalRates) {
  return {
    junior: globalRates && Number.isFinite(globalRates.junior) ? globalRates.junior : DEFAULT_RATES.junior,
    mid:    globalRates && Number.isFinite(globalRates.mid)    ? globalRates.mid    : DEFAULT_RATES.mid,
    senior: globalRates && Number.isFinite(globalRates.senior) ? globalRates.senior : DEFAULT_RATES.senior,
  };
}
