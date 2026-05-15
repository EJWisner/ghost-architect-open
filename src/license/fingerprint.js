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
// Windows (uses PowerShell Get-CimInstance — wmic was removed in Win11
// 25H2 and Win10 22H2 cannot reinstall it; PowerShell is the supported
// path going forward. Falls back to registry MachineGuid + env vars when
// PowerShell is locked down):
//   1. Win32_ComputerSystemProduct UUID
//   2. Win32_BIOS SerialNumber
//   3. Win32_Processor Name
//   4. Win32_ComputerSystem Model
//
//   Fallback chain when PowerShell fails or returns empty:
//     - HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (registry,
//       universally readable, stable across hardware changes)
//     - PROCESSOR_IDENTIFIER / PROCESSOR_ARCHITECTURE env vars
//     - COMPUTERNAME env var
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

// Some hardware ships with non-discriminating placeholder values in WMI/SMBIOS
// fields. Two completely different machines with stripped SMBIOS would otherwise
// fingerprint identically because all their placeholder values are equal. We
// treat known placeholders as empty so they hash to the MISSING_SENTINEL and
// stop counting toward 3-of-4 matches.
//
// All comparisons against the *normalized* form (already lowercased,
// whitespace-collapsed).
const NON_DISCRIMINATING_VALUES = new Set([
  '',
  '00000000-0000-0000-0000-000000000000',                  // SMBIOS all-zeros UUID
  'ffffffff-ffff-ffff-ffff-ffffffffffff',                  // SMBIOS all-ones UUID
  'to be filled by o.e.m.',                                // generic OEM placeholder
  'to be filled by o.e.m',                                 // dotless variant
  'default string',                                        // Dell stripped SMBIOS
  'not specified',                                         // some Intel NUC boards
  'system serial number',                                  // motherboard-default placeholder
  'system manufacturer',
  'system product name',
  'oem',                                                   // some virt platforms
  'none',
  'n/a',
  'na',
  'unknown',
]);

function discriminating(normalizedValue) {
  return !NON_DISCRIMINATING_VALUES.has(normalizedValue);
}

function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
      ...opts,
    });
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
//
// Strategy: try PowerShell Get-CimInstance first (one process call collecting
// all 4 components via JSON output for robust parsing). If that fails or
// returns nothing useful, fall back to registry + env vars so we still get
// SOME signal on locked-down corporate machines where PowerShell is blocked
// by group policy or ConstrainedLanguage restricts CIM access.
//
// We never call wmic — it has been removed from Win11 25H2 onward and is
// no longer installable on Win10 22H2, so building a license layer that
// depends on it is shipping a known-broken product to Medline.

function runPowerShell(script) {
  // -NoProfile: skip $PROFILE so we don't inherit corporate profile errors
  // -NonInteractive: never prompt
  // -ExecutionPolicy Bypass: corp policies often block default execution
  // -OutputFormat Text: avoid CLIXML wrapping the result
  // Single-line escape: collapse newlines so we pass one -Command argument.
  const flat = script.replace(/\r?\n/g, '; ');
  return safeExec(
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -Command "${flat.replace(/"/g, '\\"')}"`,
    { timeout: 8000 } // PS startup is slow on cold boot; give it a bit more
  );
}

function windowsComponentsViaPowerShell() {
  // One combined call: get all four properties, emit as 4 lines we can split.
  // We use Format-List style "Name : Value" parsing — robust against
  // properties that contain commas, quotes, or whitespace.
  const script = `
$ErrorActionPreference = 'SilentlyContinue';
$uuid  = (Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction SilentlyContinue).UUID;
$serial = (Get-CimInstance -ClassName Win32_BIOS -ErrorAction SilentlyContinue).SerialNumber;
$cpu   = (Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name;
$model = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue).Model;
Write-Output ('UUID=' + $uuid);
Write-Output ('SERIAL=' + $serial);
Write-Output ('CPU=' + $cpu);
Write-Output ('MODEL=' + $model);
  `.trim();

  const out = runPowerShell(script);
  if (!out) return null;

  const result = { c1: '', c2: '', c3: '', c4: '' };
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(UUID|SERIAL|CPU|MODEL)=(.*)$/);
    if (!m) continue;
    const val = m[2].trim();
    if (m[1] === 'UUID')   result.c1 = val;
    if (m[1] === 'SERIAL') result.c2 = val;
    if (m[1] === 'CPU')    result.c3 = val;
    if (m[1] === 'MODEL')  result.c4 = val;
  }
  // If everything came back empty, signal failure so caller can try fallback.
  if (!result.c1 && !result.c2 && !result.c3 && !result.c4) return null;
  return result;
}

function readMachineGuidFromRegistry() {
  // `reg query` is always available and works without PowerShell. The
  // MachineGuid is generated at OS install time and is stable across all
  // hardware changes — only an OS reinstall regenerates it. This makes it
  // a reasonable substitute for the BIOS UUID when WMI is unreachable.
  const out = safeExec('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid');
  const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
  return m ? m[1] : '';
}

function windowsComponentsViaFallback() {
  // Last-resort fallback — combines the registry MachineGuid (which is
  // every-Windows reliable) with env-var-derived signals. None of these
  // require PowerShell or any non-default tools.
  const machineGuid = readMachineGuidFromRegistry();
  const cpuId = process.env.PROCESSOR_IDENTIFIER || '';     // e.g. "Intel64 Family 6 Model 158 Stepping 10, GenuineIntel"
  const cpuArch = process.env.PROCESSOR_ARCHITECTURE || ''; // e.g. "AMD64"
  const computerName = process.env.COMPUTERNAME || '';

  return {
    c1: machineGuid,
    c2: cpuId,
    c3: cpuArch,
    c4: computerName,
  };
}

function windowsComponents() {
  const primary = windowsComponentsViaPowerShell();
  if (primary) {
    // If PowerShell gave us at least 2 non-empty components, use it. If
    // only 0-1 came back (very rare, e.g. virtualized box with stripped
    // SMBIOS), splice in registry fallback values for the empty slots so
    // we still get 4 reasonably distinct hashes.
    const nonEmpty = ['c1','c2','c3','c4'].filter(k => primary[k]).length;
    if (nonEmpty >= 2) {
      if (!primary.c1) primary.c1 = readMachineGuidFromRegistry();
      return primary;
    }
  }
  // Fallback path: PowerShell unavailable / blocked / returned nothing.
  return windowsComponentsViaFallback();
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
  // Treat non-discriminating placeholder values (all-zeros UUID, "to be filled
  // by O.E.M.", etc.) as empty so they hash to MISSING_SENTINEL. This stops
  // two stripped-SMBIOS boxes from colliding on identical placeholder values.
  return [c.c1, c.c2, c.c3, c.c4].map(v => sha256Hex(discriminating(v) ? v : MISSING_SENTINEL));
}

// 3-of-4 fuzzy match using set-intersection semantics. Returns
// { match, matchCount, freeMissingMatches } where matchCount is the count
// of DISTINCT hashes present in both arrays, after subtracting any
// "free" matches caused by the MISSING_SENTINEL being equal on both sides.
//
// Set-intersection (not array-iteration) is critical: if current contains
// the same hash twice (e.g. CPU brand equals product name on a stripped
// SMBIOS box, both producing the same empty-after-normalize string), naive
// iteration over current counts that one hash twice against stored, which
// can promote a 2-distinct-match into a passing 3-of-4. Counting distinct
// hashes only is the correct semantics for "3 of 4 components match".
export function matchesFingerprint(currentHashes, storedHashes) {
  if (!Array.isArray(currentHashes) || currentHashes.length !== 4) {
    return { match: false, matchCount: 0, reason: 'current fingerprint malformed' };
  }
  if (!Array.isArray(storedHashes) || storedHashes.length !== 4) {
    return { match: false, matchCount: 0, reason: 'stored fingerprint malformed' };
  }
  const missingHash = sha256Hex(MISSING_SENTINEL);

  // Build sets — duplicates collapse, which is exactly the semantics we want.
  const currentSet = new Set(currentHashes);
  const storedSet = new Set(storedHashes);

  // Intersect.
  let intersection = 0;
  for (const h of currentSet) {
    if (storedSet.has(h)) intersection++;
  }

  // If the missing-sentinel hash is in both sets, that match is "free" —
  // both sides are equally broken on at least one slot, which doesn't
  // demonstrate machine identity. Subtract it.
  const missingMatchedBothSides =
    currentSet.has(missingHash) && storedSet.has(missingHash) ? 1 : 0;

  const realMatches = intersection - missingMatchedBothSides;
  return {
    match: realMatches >= 3,
    matchCount: realMatches,
    freeMissingMatches: missingMatchedBothSides,
  };
}

// Re-export sha256 helper for the generator script.
export { sha256Hex };
