// src/utils/paths.js — filesystem path helpers shared across Ghost.

import path from 'path';
import os from 'os';

// Expand a leading ~ (or ~/) to the user's home directory. A shell expands
// the tilde before a program ever sees it, but a path typed into an inquirer
// prompt arrives literally, so we expand here before any fs.existsSync /
// fs.statSync / AdmZip call. Non-tilde paths (and the 'back' / '' sentinels
// the loader relies on) pass through untouched.
export function expandTilde(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~')          return os.homedir();
  return p;
}
