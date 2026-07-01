// src/utils/sampling-params.js
// Shared temperature-guard utility for Anthropic API calls.
// Models listed here return HTTP 400 if temperature/top_p/top_k are set.
// Keep in sync with PRICING table in src/core/estimator.js.
// When adding a new model, verify whether it rejects temperature and update here.

export const MODELS_WITHOUT_TEMPERATURE = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
]);

// Prefix matches for dated snapshot variants (e.g. claude-sonnet-5-20250601)
export const MODEL_PREFIXES_WITHOUT_TEMPERATURE = [
  'claude-opus-4-7-',
  'claude-opus-4-8-',
  'claude-sonnet-5-',
  'claude-opus-5-',
  'claude-fable-5-',
];

export function modelRejectsTemperature(model) {
  if (!model) return false;
  if (MODELS_WITHOUT_TEMPERATURE.has(model)) return true;
  return MODEL_PREFIXES_WITHOUT_TEMPERATURE.some(prefix => model.startsWith(prefix));
}

export function getSamplingParams(temperature, model) {
  if (modelRejectsTemperature(model)) return {};
  return { temperature };
}
