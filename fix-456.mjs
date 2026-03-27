import fs from 'fs';
import path from 'path';

const ROOT = process.env.GP_ROOT || process.cwd();

// ─── 1. multipass.js — auto-retry + timeout on callClaude ────────────────────
{
  const file = path.join(ROOT, 'src/core/multipass.js');
  let src = fs.readFileSync(file, 'utf8');

  // Add sleep + retry constants after the imports block
  const IMPORT_ANCHOR = `function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }`;
  const RETRY_BLOCK = `
// ── Retry / resilience helpers ────────────────────────────────────────────────
const OVERLOAD_RETRY_DELAYS = [15, 30, 60]; // seconds between retries
const PASS_TIMEOUT_MS       = 8 * 60 * 1000; // 8 minutes — warn if exceeded

function sleep(s) { return new Promise(r => setTimeout(r, s * 1000)); }

function isOverloadErr(err) {
  const msg = err?.message || '';
  return err?.status === 529 || msg.includes('529') || msg.includes('overloaded');
}

function isRateLimitErr(err) {
  const msg = err?.message || '';
  return err?.status === 429 || msg.includes('429') || msg.includes('rate_limit');
}

`;

  if (!src.includes('OVERLOAD_RETRY_DELAYS')) {
    src = src.replace(IMPORT_ANCHOR, RETRY_BLOCK + IMPORT_ANCHOR);
    console.log('✓ Added retry constants to multipass.js');
  } else {
    console.log('⚠ Retry constants already present — skipping');
  }

  // Replace callClaude with a retrying version
  const OLD_CALL_CLAUDE = `async function callClaude(prompt, system, maxTokens = 8096) {
  const anthropic = getClient();
  let result = '';
  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: prompt }]
  });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      result += chunk.delta.text;
    }
  }
  return result;
}`;

  const NEW_CALL_CLAUDE = `async function callClaudeRaw(prompt, system, maxTokens = 8096) {
  const anthropic = getClient();
  let result = '';
  
  // Timeout warning — if no response after PASS_TIMEOUT_MS, warn user
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    process.stdout.write(chalk.yellow('\\n  ⚠  Pass is taking longer than expected — API may be slow. Still waiting...\\n'));
  }, PASS_TIMEOUT_MS);

  try {
    const stream = anthropic.messages.stream({
      model: getModel(), max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: prompt }]
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        result += chunk.delta.text;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
  return result;
}

async function callClaude(prompt, system, maxTokens = 8096) {
  for (let attempt = 0; attempt <= OVERLOAD_RETRY_DELAYS.length; attempt++) {
    try {
      return await callClaudeRaw(prompt, system, maxTokens);
    } catch (err) {
      const isLast = attempt === OVERLOAD_RETRY_DELAYS.length;
      if (isOverloadErr(err) || isRateLimitErr(err)) {
        if (isLast) throw err; // give up after all retries
        const wait = OVERLOAD_RETRY_DELAYS[attempt];
        process.stdout.write(chalk.yellow(\`\\n  ⏳ API overloaded — waiting \${wait}s and retrying (attempt \${attempt + 1}/\${OVERLOAD_RETRY_DELAYS.length})...\\n\`));
        await sleep(wait);
        process.stdout.write(chalk.gray('  Retrying...\\n'));
        continue;
      }
      throw err; // non-retryable error — rethrow immediately
    }
  }
}`;

  if (!src.includes('callClaudeRaw')) {
    src = src.replace(OLD_CALL_CLAUDE, NEW_CALL_CLAUDE);
    console.log('✓ Replaced callClaude with retrying version in multipass.js');
  } else {
    console.log('⚠ callClaudeRaw already present — skipping');
  }

  fs.writeFileSync(file, src, 'utf8');
}

// ─── 2. multipass.js — checkpoint write after each pass ──────────────────────
{
  const file = path.join(ROOT, 'src/core/multipass.js');
  let src = fs.readFileSync(file, 'utf8');

  // Add checkpoint helpers after the retry helpers
  const CHECKPOINT_HELPERS = `
// ── Checkpoint helpers ────────────────────────────────────────────────────────
function getCheckpointPath(projectLabel) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir  = path.join(home, 'Ghost Architect Reports', '.checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  const safe = (projectLabel || 'unnamed').replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
  return path.join(dir, \`\${safe}.checkpoint.json\`);
}

export function writeCheckpoint(projectLabel, passNum, totalPasses, passResults) {
  try {
    const cpPath = getCheckpointPath(projectLabel);
    const data = {
      projectLabel,
      completedPass: passNum,
      totalPasses,
      passResults,
      timestamp: Date.now(),
    };
    fs.writeFileSync(cpPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { /* checkpoint write failure is non-fatal */ }
}

export function readCheckpoint(projectLabel) {
  try {
    const cpPath = getCheckpointPath(projectLabel);
    if (!fs.existsSync(cpPath)) return null;
    const data = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
    // Only valid if < 24 hours old and has at least one completed pass
    const ageHours = (Date.now() - data.timestamp) / (1000 * 60 * 60);
    if (ageHours > 24 || !data.passResults?.length) return null;
    return data;
  } catch (e) { return null; }
}

export function clearCheckpoint(projectLabel) {
  try {
    const cpPath = getCheckpointPath(projectLabel);
    if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
  } catch (e) { /* non-fatal */ }
}

`;

  if (!src.includes('getCheckpointPath')) {
    // Insert after the retry helpers block
    src = src.replace(
      '// ── Single pass ─',
      CHECKPOINT_HELPERS + '// ── Single pass ─'
    );
    console.log('✓ Added checkpoint helpers to multipass.js');
  } else {
    console.log('⚠ Checkpoint helpers already present — skipping');
  }

  // Add path import if not present
  if (!src.includes("import path from 'path'") && !src.includes('import path from "path"')) {
    src = src.replace("import Anthropic from '@anthropic-ai/sdk';", "import Anthropic from '@anthropic-ai/sdk';\nimport path from 'path';");
    console.log('✓ Added path import to multipass.js');
  }

  fs.writeFileSync(file, src, 'utf8');
}

// ─── 3. pdf-generator.js — fix version display ───────────────────────────────
{
  const file = path.join(ROOT, 'src/pdf-generator.js');
  let src = fs.readFileSync(file, 'utf8');

  // The version is passed in meta.version but falls back to '4.5' hardcoded
  const OLD_VER = `Ghost Architect v\${meta.version || '4.5'}  |  ghostarchitect.dev`;
  const NEW_VER = `Ghost Architect v\${meta.version || '4.5.5'}  |  ghostarchitect.dev`;

  if (src.includes(OLD_VER)) {
    src = src.replace(OLD_VER, NEW_VER);
    console.log('✓ Fixed version fallback in pdf-generator.js');
  } else if (src.includes("'4.5'")) {
    src = src.replace("'4.5'", "'4.5.5'");
    console.log('✓ Fixed version fallback (alternate pattern) in pdf-generator.js');
  } else {
    console.log('⚠ Version pattern not found — check manually');
  }

  fs.writeFileSync(file, src, 'utf8');
}

// ─── 4. reports.js — pass version into PDF meta ──────────────────────────────
{
  const file = path.join(ROOT, 'src/reports.js');
  let src = fs.readFileSync(file, 'utf8');

  // Check if version is being passed to generatePDF
  if (!src.includes('meta.version') && !src.includes("version:")) {
    console.log('⚠ reports.js — version not passed to PDF meta. Check manually after patch.');
  } else {
    console.log('✓ reports.js appears to pass version already');
  }
}

console.log('\n✅ 4.5.6 patch complete. Review changes then commit.');
