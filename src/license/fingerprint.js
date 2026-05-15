// src/license/fingerprint.js
//
// Hardware fingerprint with 3-of-4 fuzzy matching. Survives RAM/storage
// swaps and OS reinstalls. Fails on new machines (correct behavior).
//
// Four components, platform-specific:
//
// macOS:
//   1. Hardware UUID (system_profiler SPHardwareDataType)
//   2. Serial Number (system_profiler SPHardwareDataType)
//   3. CPU brand string (sysctl machdep.cpu.brand_string)
//   4. Model Identifier (system_profiler SPHardwareDataType)
//
// Linux:
//   1. /etc/machine-id (or /var/lib/dbus/machine-id)
//   2. /sys/class/dmi/id/product_uuid (root) | product_serial (fallback)
//   3. /proc/cpuinfo model name (first occurrence)
//   4. /sys/class/dmi/id/product_name
//
// Windows:
//   1. wmic csproduct get UUID
//   2. wmic bios get SerialNumber
//   3. wmic cpu get Name
//   4. wmic computersystem get Model
//
// Each component is normalized (trim, lowercase, collapse whitespace) and
// hashed with sha256. The token stores all four hashes. At validation we
// recompute, and require at least 3 to match members of the stored array.

import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (e) {
    return '';
  }
}

function safeRead(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (e) {
    return '';
  }
}

// ── macOS collectors ────────────────────────────────────────────────────────

function macComponents() {
  const hw = safeExec('system_profiler SPHardwareDataType 2>/dev/null');
  const lines = hw.split('\n');

  function findLine(label) {
    const line = lines.find(l => l.trim().toLowerCase().startsWith(label.toLowerCase()));
    if (!line) return '';
    const idx = line.indexOf(':');
    return idx >= 0 ? line.slice(idx + 1).trim() : '';
  }

  return {
    c1: findLine('Hardware UUID'),
    c2: findLine('Serial Number (system)') || findLine('Serial Number'),
    c3: safeExec('sysctl -n machdep.cpu.brand_string').trim(),
    c4: findLine('Model Identifier'),
  };
}

// ── Linux collectors ────────────────────────────────────────────────────────

function linuxComponents() {
  const machineId =
    safeRead('/etc/machine-id').trim() ||
    safeRead('/var/lib/dbus/machine-id').trim();

  const productUuid =
    safeRead('/sys/class/dmi/id/product_uuid').trim() ||
    safeRead('/sys/class/dmi/id/product_serial').trim();

  const cpuInfo = safeRead('/proc/cpuinfo');
  const cpuMatch = cpuInfo.match(/^model name\s*:\s*(.+)$/m);
  const cpuModel = cpuMatch ? cpuMatch[1].trim() : '';

  const productName = safeRead('/sys/class/dmi/id/product_name').trim();

  return { c1: machineId, c2: productUuid, c3: cpuModel, c4: productName };
}

// ── Windows collectors ──────────────────────────────────────────────────────

function parseWmicValue(out) {
  // wmic output is two lines: header, then value. Possibly trailing blanks.
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return '';
  return lines[1];
}

function windowsComponents() {
  return {
    c1: parseWmicValue(safeExec('wmic csproduct get UUID')),
    c2: parseWmicValue(safeExec('wmic bios get SerialNumber')),
    c3: parseWmicValue(safeExec('wmic cpu get Name')),
    c4: parseWmicValue(safeExec('wmic computersystem get Model')),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

// Collect raw components for the current platform. Returns
// { c1, c2, c3, c4, platform, raw } where each cN is a normalized string
// (may be empty if collection failed for that slot).
export function collectComponents() {
  let raw;
  const platform = process.platform;
  if (platform === 'darwin') raw = macComponents();
  else if (platform === 'linux') raw = linuxComponents();
  else if (platform === 'win32') raw = windowsComponents();
  else raw = { c1: '', c2: '', c3: '', c4: '' };

  return {
    c1: normalize(raw.c1),
    c2: normalize(raw.c2),
    c3: normalize(raw.c3),
    c4: normalize(raw.c4),
    platform,
    raw,
  };
}

// Return the 4 sha256 hashes for the current machine, in deterministic
// order (c1, c2, c3, c4). Empty components hash the empty string sentinel
// 'GHOST_FINGERPRINT_MISSING' so a machine with two missing components
// can't collide with another machine that also has two missing — the
// missing-slot hash is constant across machines and won't count toward
// the 3-of-4 match unless both sides are equally broken.
const MISSING_SENTINEL = 'GHOST_FINGERPRINT_MISSING';

export function currentFingerprintHashes() {
  const c = collectComponents();
  return [c.c1, c.c2, c.c3, c.c4].map(v => sha256Hex(v || MISSING_SENTINEL));
}

// 3-of-4 fuzzy match: returns { match: boolean, matchCount: number,
// missingComponents: number } given a current set and a stored set.
// Both arrays must be length 4. Order doesn't matter — we compare as sets.
export function matchesFingerprint(currentHashes, storedHashes) {
  if (!Array.isArray(currentHashes) || currentHashes.length !== 4) {
    return { match: false, matchCount: 0, reason: 'current fingerprint malformed' };
  }
  if (!Array.isArray(storedHashes) || storedHashes.length !== 4) {
    return { match: false, matchCount: 0, reason: 'stored fingerprint malformed' };
  }
  const stored = new Set(storedHashes);
  let matchCount = 0;
  for (const h of currentHashes) {
    if (stored.has(h)) matchCount++;
  }
  // Count missing components on the current side — if a current slot is
  // the MISSING_SENTINEL hash AND it matched stored (because stored is
  // also missing), that match is "free" and shouldn't count toward the
  // 3-of-4 threshold. Penalize accordingly.
  const missingHash = sha256Hex(MISSING_SENTINEL);
  let freeMissingMatches = 0;
  for (const h of currentHashes) {
    if (h === missingHash && stored.has(missingHash)) freeMissingMatches++;
  }
  const realMatches = matchCount - freeMissingMatches;
  return {
    match: realMatches >= 3,
    matchCount: realMatches,
    freeMissingMatches,
  };
}

// Re-export sha256 helper for the generator script.
export { sha256Hex };
