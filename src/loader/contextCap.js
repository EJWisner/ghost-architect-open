// src/loader/contextCap.js
// Context-size ceiling for Ghost Open™.
//
// Ghost Open™ is free for one person and runs on the user's own Anthropic
// key, so every user gets the same, highest ceiling. --max-context and a
// saved `ghost --reconfigure` value can lower it for a run; nothing raises it
// above CONTEXT_CAP.

import chalk from 'chalk';
import { SYM } from '../cli/symbols.js';

export const CONTEXT_CAP = 200000;

/**
 * Resolve the effective context cap for this run.
 *
 * @param {number|null|undefined} userRequested - value from --max-context or
 *   saved settings, or null/undefined for the full cap.
 * @param {'cli'|'config'|'default'|string} [source='default'] - where
 *   userRequested came from, so the clamp warning names the real source.
 * @returns {{ effective: number, clamped: boolean, cap: number }}
 */
export function resolveContextCap(userRequested, source = 'default') {
  const cap = CONTEXT_CAP;

  if (userRequested == null) {
    return { effective: cap, clamped: false, cap };
  }

  if (typeof userRequested !== 'number' || !Number.isFinite(userRequested) || userRequested <= 0) {
    console.warn(chalk.yellow(`${SYM.warn} Invalid --max-context value. Using the default: ${cap.toLocaleString()} tokens.`));
    return { effective: cap, clamped: false, cap };
  }

  if (userRequested > cap) {
    let msg;
    if (source === 'config') {
      msg = `${SYM.warn} Context cap clamped from ${userRequested.toLocaleString()} (from saved settings) to the ${cap.toLocaleString()} maximum. Run \`ghost --reconfigure\` to update your default.`;
    } else if (source === 'cli') {
      msg = `${SYM.warn} --max-context ${userRequested.toLocaleString()} exceeds the maximum (${cap.toLocaleString()}). Clamping to ${cap.toLocaleString()}.`;
    } else {
      msg = `${SYM.warn} Context value ${userRequested.toLocaleString()} exceeds the maximum (${cap.toLocaleString()}). Clamping to ${cap.toLocaleString()}.`;
    }
    console.warn(chalk.yellow(msg));
    return { effective: cap, clamped: true, cap };
  }

  // A saved value below the ceiling is honored (it is the user's preference),
  // but say so: installs from before 12.0.0 saved a lower default during setup,
  // and scanning at a fraction of the available context with no hint is a
  // silent quality loss. CLI values stay quiet: --max-context is deliberate.
  if (source === 'config' && userRequested < cap) {
    console.warn(chalk.yellow(
      `${SYM.warn} Your saved context limit (${userRequested.toLocaleString()} tokens) is below the ${cap.toLocaleString()} maximum. Run \`ghost --reconfigure\` to raise it.`
    ));
  }

  return { effective: userRequested, clamped: false, cap };
}

/** The ceiling without any user override. */
export function getContextCap() {
  return CONTEXT_CAP;
}
