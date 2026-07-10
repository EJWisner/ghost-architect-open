// src/cli/symbols.js
//
// Single source of truth for console glyphs.
//
// The legacy Windows console (cmd.exe, and PowerShell 5.1 on a non-UTF-8 code
// page) renders ✓ ✗ ⚠ as mojibake or as a literal `?`. Every mode therefore
// needs an ASCII fallback. Nine files each declared their own private
// `const SYM = { check: ..., cross: ... }`, which meant:
//
//   1. Any glyph not in that two-key object got hardcoded inline and shipped
//      raw to Windows anyway (about 30 console lines did exactly this).
//   2. Adding a symbol meant editing nine files, so nobody did.
//
// Import SYM from here. Do not redeclare it, and do not inline a raw glyph in
// console output. If you need a new symbol, add it to this object.

export const IS_WINDOWS = process.platform === 'win32';

export const SYM = {
  check:  IS_WINDOWS ? '[OK]'   : '✓',
  cross:  IS_WINDOWS ? '[X]'    : '✗',
  warn:   IS_WINDOWS ? '[!]'    : '⚠',
  info:   IS_WINDOWS ? '[i]'    : 'ℹ',
  arrow:  IS_WINDOWS ? '->'     : '→',
  bullet: IS_WINDOWS ? '*'      : '•',
};
