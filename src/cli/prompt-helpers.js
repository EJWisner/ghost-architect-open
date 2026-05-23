// src/cli/prompt-helpers.js
//
// Shared helpers for consistent universal-escape behavior across all
// inquirer.prompt sites in bin/ghost.js and the mode files. Imported by
// any code that wants its list-prompt to offer a "Back" option without
// each call site rebuilding the choice array manually.
//
// Filed 2026-05-23 as part of the universal-escape-mechanism workstream.
// See TODO-architect-cli-universal-escape-mechanism-v7.md for the rationale.
//
// Design:
//   - BACK_VALUE: sentinel value the caller checks for to detect "user
//     wanted to back out." Distinct from any real option value.
//   - backChoice(label?): returns a single inquirer choice object that
//     uses BACK_VALUE under the hood. Callers append it to their choice
//     array (typically after an inquirer.Separator) — opt-in, not
//     auto-injected, so existing menus with their own cancel paths don't
//     get accidentally double-cancelled.
//   - isBack(value): tiny predicate. Makes call sites read naturally:
//     `if (isBack(action)) return;`
//
// Companion pattern for text-input prompts: the 'back' keyword. Inquirer
// v9 has no built-in Esc-to-cancel mechanism (verified 2026-05-23: no
// AbortController support, no keypress hook documented in the public API).
// For the highest-pain text inputs (loader paths, license key, chat label),
// callers accept the literal string 'back' (case-insensitive) and treat
// it as the back-out signal. Discoverable via the prompt's message text:
//   "Path to codebase (or 'back' to return)"
// Proper Esc-handling deferred — see TODO-architect-cli-text-input-esc-handler-v7.md.
//
// Future companion: src/cli/session-state.js (reserved, not yet created)
// will house Stage 3's session-scoped soft-gate callout tracking. Same
// directory because both are CLI-layer concerns that don't fit neatly
// into mode files or src/license/.

export const BACK_VALUE = '__ghost_back__';

/**
 * Build an inquirer choice that signals back-out when selected.
 * Default label is "Back"; pass a different label for top-level menus
 * ("Exit Ghost"), modal cancellations ("Cancel"), or context-specific
 * back-out actions ("Cancel scan", "Skip").
 *
 * Always pair with an inquirer.Separator() immediately before for visual
 * grouping. The helper does not construct the Separator itself because
 * doing so would force this module to import inquirer for a single line.
 */
export function backChoice(label = '\u2190  Back') {
  return { name: label, value: BACK_VALUE };
}

/**
 * Predicate for detecting back-out from a list-prompt answer.
 *
 * Usage:
 *   const { action } = await inquirer.prompt([{ ..., choices: [..., backChoice()] }]);
 *   if (isBack(action)) return;  // or continue, depending on loop context
 */
export function isBack(value) {
  return value === BACK_VALUE;
}

/**
 * Companion keyword for text-input prompts. Caller wires this manually:
 *   const { path } = await inquirer.prompt([{ type: 'input', ... }]);
 *   if (isBackKeyword(path)) return;
 *
 * Always check BEFORE other validation. Empty string and 'back' are
 * distinct signals: empty means the user just hit Enter (handle per
 * prompt — usually re-prompt or use default), 'back' means they
 * explicitly want out.
 */
export function isBackKeyword(input) {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim().toLowerCase();
  return trimmed === 'back';
}
