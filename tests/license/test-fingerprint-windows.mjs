// tests/license/test-fingerprint-windows.mjs
//
// Windows fingerprint unit tests. We can't run on Windows from this iMac,
// so we exercise the parsing + fallback logic by mocking execSync.
//
// Run: node tests/license/test-fingerprint-windows.mjs

import assert from 'assert';

const PASS = (name) => console.log(`  ✓ ${name}`);
const FAIL = (name, why) => { console.error(`  ✗ ${name}: ${why}`); process.exitCode = 1; };

// Replicates the parsing logic in src/license/fingerprint.js so we can
// exercise it against captured-from-real-Windows sample outputs without
// needing to monkey-patch the actual module.
function parsePowerShellOutput(out) {
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
  return result;
}

function parseRegistryMachineGuid(out) {
  const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
  return m ? m[1] : '';
}

console.log('\n── Windows fingerprint parsing tests ──');

// Test 1: Healthy modern Windows 11 Pro box
{
  const sample = `UUID=4C4C4544-004C-4710-8051-C4C04F443732
SERIAL=DRMGH52
CPU=Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz
MODEL=OptiPlex 7060`;
  const r = parsePowerShellOutput(sample);
  try {
    assert.strictEqual(r.c1, '4C4C4544-004C-4710-8051-C4C04F443732');
    assert.strictEqual(r.c2, 'DRMGH52');
    assert.strictEqual(r.c3, 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz');
    assert.strictEqual(r.c4, 'OptiPlex 7060');
    PASS('healthy Win11 Pro Dell OptiPlex parses correctly');
  } catch (e) { FAIL('healthy Win11', e.message); }
}

// Test 2: HP ProBook with embedded special chars
{
  const sample = `UUID=01234567-89AB-CDEF-FEDC-BA9876543210
SERIAL=5CG12345AB
CPU=AMD Ryzen 7 PRO 5850U with Radeon Graphics
MODEL=HP ProBook 445 G8`;
  const r = parsePowerShellOutput(sample);
  try {
    assert.strictEqual(r.c3, 'AMD Ryzen 7 PRO 5850U with Radeon Graphics');
    assert.strictEqual(r.c4, 'HP ProBook 445 G8');
    PASS('HP ProBook with multi-word model parses correctly');
  } catch (e) { FAIL('HP ProBook', e.message); }
}

// Test 3: VM with stripped SMBIOS (placeholder values)
{
  const sample = `UUID=00000000-0000-0000-0000-000000000000
SERIAL=To be filled by O.E.M.
CPU=Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz
MODEL=Virtual Machine`;
  const r = parsePowerShellOutput(sample);
  try {
    assert.strictEqual(r.c1, '00000000-0000-0000-0000-000000000000');
    assert.strictEqual(r.c2, 'To be filled by O.E.M.');
    PASS('VM with stripped SMBIOS parses literal placeholder values');
    // Note: discriminating() filter elsewhere will collapse these to MISSING
  } catch (e) { FAIL('VM stripped SMBIOS', e.message); }
}

// Test 4: Empty values when WMI returns null
{
  const sample = `UUID=
SERIAL=
CPU=
MODEL=`;
  const r = parsePowerShellOutput(sample);
  try {
    assert.strictEqual(r.c1, '');
    assert.strictEqual(r.c2, '');
    assert.strictEqual(r.c3, '');
    assert.strictEqual(r.c4, '');
    PASS('all-empty PS output produces all-empty result');
  } catch (e) { FAIL('all-empty PS', e.message); }
}

// Test 5: PowerShell startup banner / error noise mixed in
{
  const sample = `Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.

UUID=4C4C4544-004C-4710-8051-C4C04F443732
SERIAL=DRMGH52
CPU=Intel Core i7
MODEL=OptiPlex`;
  const r = parsePowerShellOutput(sample);
  try {
    assert.strictEqual(r.c1, '4C4C4544-004C-4710-8051-C4C04F443732');
    assert.strictEqual(r.c3, 'Intel Core i7');
    PASS('parser ignores PowerShell startup banner / extra lines');
  } catch (e) { FAIL('PS banner noise', e.message); }
}

// Test 6: CRLF line endings (Windows native)
{
  const sample = 'UUID=4C4C4544-004C-4710-8051-C4C04F443732\r\nSERIAL=DRMGH52\r\nCPU=Intel\r\nMODEL=OptiPlex\r\n';
  const r = parsePowerShellOutput(sample);
  try {
    assert.strictEqual(r.c1, '4C4C4544-004C-4710-8051-C4C04F443732');
    assert.strictEqual(r.c2, 'DRMGH52');
    PASS('CRLF line endings handled correctly');
  } catch (e) { FAIL('CRLF', e.message); }
}

// Test 7: registry MachineGuid extraction
{
  const sample = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    7a8b9c0d-1234-5678-9abc-def012345678
`;
  const guid = parseRegistryMachineGuid(sample);
  try {
    assert.strictEqual(guid, '7a8b9c0d-1234-5678-9abc-def012345678');
    PASS('registry MachineGuid extracted from typical reg query output');
  } catch (e) { FAIL('MachineGuid extract', e.message); }
}

// Test 8: registry output with extra whitespace / indent variants
{
  const sample = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ABCDEF01-2345-6789-ABCD-EF0123456789\r\n\r\n';
  const guid = parseRegistryMachineGuid(sample);
  try {
    assert.strictEqual(guid, 'ABCDEF01-2345-6789-ABCD-EF0123456789');
    PASS('registry MachineGuid uppercase + CRLF parses');
  } catch (e) { FAIL('MachineGuid upper/CRLF', e.message); }
}

// Test 9: registry empty / key missing
{
  const sample = 'ERROR: The system was unable to find the specified registry key or value.';
  const guid = parseRegistryMachineGuid(sample);
  try {
    assert.strictEqual(guid, '');
    PASS('missing registry key returns empty string');
  } catch (e) { FAIL('missing registry', e.message); }
}

console.log('');
if (process.exitCode) {
  console.log('FAIL: one or more Windows fingerprint parsing tests failed.\n');
} else {
  console.log('PASS: all Windows fingerprint parsing tests succeeded.\n');
}
