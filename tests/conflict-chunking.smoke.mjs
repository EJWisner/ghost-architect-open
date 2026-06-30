/**
 * Ghost Architect™ — conflict chunking smoke test
 *
 * Exercises the Conflict Detection body-size chunker. The chunker
 * (`chunkFileMapForConflict` + `CONFLICT_CHUNK_LIMIT_BYTES`) is defined and
 * used internally by `buildConflictPrompts` in src/modes/watcher-commit.js;
 * neither is exported, so the logic is REPLICATED here verbatim. If you change
 * `chunkFileMapForConflict` or `CONFLICT_CHUNK_LIMIT_BYTES` in
 * watcher-commit.js, change it here too — these two copies MUST stay in sync.
 *
 * What this guards: large codebases get split into multiple conflict batch
 * requests so each POST body stays under ~1 MB (CI networks drop large
 * uploads). Every chunk must hold only complete file entries (never split a
 * file mid-content), and no chunk may exceed the byte limit unless a single
 * file is itself oversized (in which case it gets its own chunk).
 */

// ── REPLICATED from src/modes/watcher-commit.js (keep in sync) ──────────────
const CONFLICT_CHUNK_LIMIT_BYTES = 900 * 1024;

function chunkFileMapForConflict(fileMap) {
  const entries = Object.entries(fileMap || {});
  const chunks = [];
  let currentChunk = '';
  let currentBytes = 0;

  for (const [fp, content] of entries) {
    const entry = `\n\n=== FILE: ${fp} ===\n${content}`;
    const entryBytes = Buffer.byteLength(entry, 'utf8');

    // If a single file exceeds the limit, it gets its own chunk.
    if (currentBytes + entryBytes > CONFLICT_CHUNK_LIMIT_BYTES && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = entry;
      currentBytes = entryBytes;
    } else {
      currentChunk += entry;
      currentBytes += entryBytes;
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks.length ? chunks : [''];
}
// ── end replicated block ────────────────────────────────────────────────────

const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
const entryOf = (fp, content) => `\n\n=== FILE: ${fp} ===\n${content}`;
const markerCount = (s) => (s.match(/=== FILE: /g) || []).length;

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected: ' + e);
    console.log('       actual:   ' + a);
    failures++;
  }
}

// ── Test 1: small fileMap (< 900 KB) → exactly 1 chunk ──────────────────────
console.log('Test 1: small fileMap produces exactly 1 chunk');
{
  const fileMap = {
    'a.js': 'x'.repeat(1000),
    'b.js': 'y'.repeat(1000),
    'c.js': 'z'.repeat(1000),
  };
  const chunks = chunkFileMapForConflict(fileMap);
  check('chunk count is 1', chunks.length, 1);
  check('chunk under limit', bytesOf(chunks[0]) < CONFLICT_CHUNK_LIMIT_BYTES, true);
  check('all three files present', markerCount(chunks[0]), 3);
}
console.log('');

// ── Test 2: ~2 MB fileMap → >= 3 chunks, each chunk < 900 KB ─────────────────
console.log('Test 2: ~2 MB fileMap splits into >=3 chunks, each under the limit');
{
  // 5 files of 400 KB each ≈ 2 MB total. None individually exceeds the limit,
  // so every resulting chunk must stay strictly under CONFLICT_CHUNK_LIMIT_BYTES.
  const fileMap = {};
  for (let i = 0; i < 5; i++) fileMap[`big${i}.js`] = 'x'.repeat(400 * 1024);
  const chunks = chunkFileMapForConflict(fileMap);
  check('at least 3 chunks', chunks.length >= 3, true);
  check('every chunk under the byte limit',
    chunks.every(c => bytesOf(c) < CONFLICT_CHUNK_LIMIT_BYTES), true);
  check('no file lost (5 markers total across chunks)',
    chunks.reduce((n, c) => n + markerCount(c), 0), 5);
}
console.log('');

// ── Test 3: a single file > 900 KB gets its own chunk ───────────────────────
console.log('Test 3: an oversized single file gets its own chunk');
{
  // A normal file precedes an oversized one. The oversized file must be
  // isolated in its own chunk rather than crammed in with the small file.
  const fileMap = {
    'small.js': 'x'.repeat(50 * 1024),
    'huge.js': 'y'.repeat(1024 * 1024), // 1 MB > 900 KB limit
  };
  const chunks = chunkFileMapForConflict(fileMap);
  check('splits into 2 chunks', chunks.length, 2);
  const hugeChunk = chunks.find(c => c.includes('huge.js'));
  check('huge file found in a chunk', !!hugeChunk, true);
  check('huge file is alone in its chunk (1 marker)', markerCount(hugeChunk), 1);
  check('huge file chunk does not contain small.js', hugeChunk.includes('small.js'), false);
}
console.log('');

// ── Test 4: empty / null fileMap → 1 chunk (empty-string fallback) ──────────
console.log('Test 4: empty or null fileMap produces one empty-string chunk');
{
  const empty = chunkFileMapForConflict({});
  check('empty fileMap → 1 chunk', empty.length, 1);
  check('empty fileMap → chunk is empty string', empty[0], '');
  const nul = chunkFileMapForConflict(null);
  check('null fileMap → 1 chunk', nul.length, 1);
  check('null fileMap → chunk is empty string', nul[0], '');
}
console.log('');

// ── Test 5: every chunk holds only complete file entries (no mid-content split) ─
console.log('Test 5: chunks contain only complete file entries, no content lost');
{
  const fileMap = {};
  for (let i = 0; i < 5; i++) fileMap[`f${i}.js`] = String.fromCharCode(97 + i).repeat(400 * 1024);
  const chunks = chunkFileMapForConflict(fileMap);

  // Each file's full entry string must appear intact in exactly one chunk.
  let allIntact = true;
  for (const [fp, content] of Object.entries(fileMap)) {
    const entry = entryOf(fp, content);
    const occurrences = chunks.filter(c => c.includes(entry)).length;
    if (occurrences !== 1) allIntact = false;
  }
  check('each file entry appears intact in exactly one chunk', allIntact, true);

  // Concatenating chunks in order must equal the full serialized context —
  // proves nothing was dropped, duplicated, or split mid-entry.
  const expectedFull = Object.entries(fileMap).map(([fp, c]) => entryOf(fp, c)).join('');
  check('chunks rejoin to the full context (no loss, no split)',
    chunks.join('') === expectedFull, true);
}
console.log('');

// Summary
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
