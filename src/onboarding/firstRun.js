// src/onboarding/firstRun.js
//
// Ghost Architect Open — first-run email capture + anonymous heartbeat.
//
// Three responsibilities:
//   1. First-run prompt for new installs (no config file yet)
//   2. Upgrade prompt for users who upgraded from pre-5.3.1 (config
//      file exists but has no userId/email fields)
//   3. Periodic usage heartbeat — a 24h-throttled anonymous ping so
//      we can see active install counts, version distribution, and
//      per-userId activity over time without collecting any PII
//
// Design principles:
//   1. Fully optional. Three states (Y/N/S), default-to-yes UX.
//   2. Graceful failure. Network errors, parse errors, signal
//      interrupts — none of them block the CLI startup.
//   3. Once per machine. Config persists at ~/.ghost-architect/
//      and is checked before any prompt logic runs.
//   4. Privacy-first. Clear disclosure, anonymous heartbeats use
//      only a locally-generated UUID + version + timestamp. No
//      email, no machine details, no file contents.
//   5. Easy opt-out. GHOST_NO_PING=1 disables all network calls.
//   6. Non-interactive contexts skip the prompt cleanly (CI, Docker,
//      scripts) — checked via process.stdin.isTTY.
//
// This module is Open-only. It does not exist on the Pro or Team
// branches; Pro/Team users provided email at purchase.

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import crypto from 'crypto';
import https from 'https';

const CONFIG_DIR = path.join(os.homedir(), '.ghost-architect');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SIGNUP_ENDPOINT = 'https://signup.ghostarchitect.dev/signup';
const POST_TIMEOUT_MS = 3000;

// Heartbeat throttle: only send a usage ping if the last one was more
// than 24 hours ago. Users who run ghost 20x/day don't generate 20x rows.
const USAGE_PING_INTERVAL_MS = 24 * 60 * 60 * 1000;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Config helpers ──────────────────────────────────────────────────────

function configExists() {
  try {
    return fs.existsSync(CONFIG_PATH);
  } catch (_) {
    return false;
  }
}

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeConfig(data) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    // Silent failure — never break the CLI over a config write.
    if (process.env.GHOST_DEBUG) {
      console.error('[firstRun] config write failed:', err.message);
    }
  }
}

// ── Network ─────────────────────────────────────────────────────────────

function pingDisabled() {
  return process.env.GHOST_NO_PING === '1';
}

function postSignup(payload) {
  return new Promise((resolve) => {
    // Respect global opt-out env var.
    if (pingDisabled()) {
      resolve({ ok: false, disabled: true });
      return;
    }

    let body;
    try {
      body = JSON.stringify(payload);
    } catch (_) {
      resolve({ ok: false });
      return;
    }

    let url;
    try {
      url = new URL(SIGNUP_ENDPOINT);
    } catch (_) {
      resolve({ ok: false });
      return;
    }

    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        port: 443,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Ghost-Client': 'ghost-architect-open',
        },
        timeout: POST_TIMEOUT_MS,
      },
      (res) => {
        // Drain response — we don't care about the body, only the status.
        res.on('data', () => {});
        res.on('end', () => {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
        });
      }
    );

    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });

    req.write(body);
    req.end();
  });
}

// Send an anonymous decline ping (no email, just userId + version +
// source + timestamp). Used on every N/S/retraction/invalid/error path
// so we see the full denominator in Airtable, not just opt-ins.
async function pingAnonymous(userId, version, source, timestamp) {
  await postSignup({
    userId,
    email: null,
    version,
    source,
    timestamp,
  });
}

// ── Prompt UI ───────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function printWelcomeFirstRun() {
  process.stdout.write(`
================================================================
  Quick question before we begin
================================================================

  Solo founder here (EJ Wisner). Want occasional product
  updates and early access to Pro features as they land
  in Open?

  ~1 email per month. No spam. Unsubscribe anytime.

  [Y]es  [N]o  [S]kip for now

`);
}

function printWelcomeUpgrade() {
  process.stdout.write(`
================================================================
  Welcome back to Ghost Architect
================================================================

  Quick ask from EJ Wisner (solo founder): we added an
  email signup so I can share product updates and early
  Pro features with active users like you.

  ~1 email per month. No spam. Unsubscribe anytime.

  [Y]es  [N]o  [S]kip for now

`);
}

// ── Retry pending sync on later runs ────────────────────────────────────

async function retryPendingSync(config) {
  if (!config) return config;
  if (config.syncStatus !== 'pending') return config;
  if (!config.email) return config;

  const result = await postSignup({
    userId: config.userId,
    email: config.email,
    version: config.version,
    source: 'cli-firstrun-retry',
    timestamp: config.promptedAt,
  });

  if (result.ok) {
    const updated = { ...config, syncStatus: 'synced' };
    writeConfig(updated);
    return updated;
  }
  // If still failing, leave syncStatus as 'pending' — we'll retry on the
  // next run. No exponential backoff needed; CLI runs are infrequent
  // enough that a daily retry is fine.
  return config;
}

// ── Usage heartbeat ─────────────────────────────────────────────────────

// Send a usage ping if we haven't sent one in the last 24h. This gives
// us a per-userId activity timeline in Airtable: who's still using
// Ghost, on what version, how often. No PII — just the anonymous UUID
// we generated locally when they first ran the CLI.
//
// Updates config.lastPingAt on successful send to throttle subsequent
// invocations. If the ping fails (network error, Worker down), we
// don't update lastPingAt, so the next run will try again.
async function maybeSendUsagePing(config, version) {
  if (!config || !config.userId) return config;
  if (pingDisabled()) return config;

  const now = Date.now();
  const lastPingAt = config.lastPingAt
    ? new Date(config.lastPingAt).getTime()
    : 0;

  if (now - lastPingAt < USAGE_PING_INTERVAL_MS) {
    return config;
  }

  const timestamp = new Date(now).toISOString();
  const result = await postSignup({
    userId: config.userId,
    email: null,
    version,
    source: 'cli-usage',
    timestamp,
  });

  if (result.ok) {
    const updated = { ...config, lastPingAt: timestamp };
    writeConfig(updated);
    return updated;
  }
  return config;
}

// ── Upgrade prompt detection ────────────────────────────────────────────

// True if the existing config predates the v5.3.1 email-capture system.
// Pre-5.3.1 configs were created by the CLI's `Configstore`-based setup
// wizard and lack the userId/email/promptedAt fields we added in 5.3.1.
//
// Note: the v5.3.1 setup wizard writes a DIFFERENT config file via
// the `configstore` npm package (it lives at ~/.config/configstore/
// ghost-architect.json on Linux/Mac, not ~/.ghost-architect/config.json).
// So in practice the "upgraded from older version" user has NO file at
// CONFIG_PATH at all — they look identical to fresh installs and get
// the first-run prompt naturally.
//
// This function exists for the edge case where a future code path
// creates a partial config at our path without a userId.
function needsUpgradePrompt(config) {
  if (!config) return false;
  if (typeof config.userId === 'string') return false;
  if (typeof config.email !== 'undefined') return false;
  if (typeof config.upgradePromptedAt === 'string') return false;
  return true;
}

// ── Prompt loop (shared by first-run and upgrade paths) ─────────────────

// Returns the answer state without writing config — caller decides what
// to write based on whether this was first-run or upgrade.
async function runPrompt(rl, isUpgrade) {
  if (isUpgrade) {
    printWelcomeUpgrade();
  } else {
    printWelcomeFirstRun();
  }

  const answer = (await ask(rl, '> ')).toLowerCase();

  if (answer === 'n' || answer === 'no') {
    process.stdout.write('\n  No problem. Running Ghost Architect...\n\n');
    return { state: 'declined' };
  }

  if (answer === 's' || answer === 'skip') {
    process.stdout.write('\n  No problem. Running Ghost Architect...\n\n');
    return { state: 'skipped' };
  }

  // Y, yes, or empty → proceed to email prompt.
  process.stdout.write('\n  Email address:\n');
  const emailRaw = await ask(rl, '> ');

  if (emailRaw === '') {
    process.stdout.write('\n  No problem. Running Ghost Architect...\n\n');
    return { state: 'retracted' };
  }

  if (!EMAIL_REGEX.test(emailRaw)) {
    process.stdout.write('\n  Doesn\'t look like a valid email, skipping.\n');
    process.stdout.write('  Running Ghost Architect...\n\n');
    return { state: 'invalid' };
  }

  return { state: 'confirmed', email: emailRaw };
}

// ── Main entry point ────────────────────────────────────────────────────

export async function checkFirstRun(version) {
  // Non-interactive contexts (CI, Docker builds, piped scripts) — the
  // readline prompt would either hang or appear broken. Skip cleanly.
  // We don't write a config either; next interactive run will prompt.
  if (!process.stdin.isTTY) {
    return;
  }

  // ── PATH 1: Config exists ──────────────────────────────────────────
  if (configExists()) {
    let existing = readConfig();

    // Retry any pending email sync first; that might also update the
    // config we work with below.
    existing = await retryPendingSync(existing);

    // Edge case: config exists but is missing userId/email fields
    // (theoretical upgrade-from-pre-5.3.1 path). Run upgrade prompt.
    if (needsUpgradePrompt(existing)) {
      await runUpgradePrompt(existing, version);
      return;
    }

    // Normal path: existing user, just send a throttled heartbeat.
    await maybeSendUsagePing(existing, version);
    return;
  }

  // ── PATH 2: Fresh install, no config yet ───────────────────────────
  await runFreshInstallPrompt(version);
}

// ── Fresh install flow ──────────────────────────────────────────────────

async function runFreshInstallPrompt(version) {
  const userId = crypto.randomUUID();
  const promptedAt = new Date().toISOString();

  // Handle Ctrl+C during prompt. Write a "declined-via-interrupt"
  // config so the prompt doesn't re-fire forever, then exit cleanly.
  // We can't await an anonymous ping here since SIGINT is synchronous,
  // but we mark the config so usage pings will start flowing on the
  // next run.
  const sigintHandler = () => {
    writeConfig({
      userId,
      email: null,
      optedIn: false,
      promptedAt,
      version,
      skippedAt: null,
      interrupted: true,
    });
    process.stdout.write('\n');
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const result = await runPrompt(rl, false);

    if (result.state === 'declined') {
      await pingAnonymous(userId, version, 'cli-firstrun-no', promptedAt);
      writeConfig({
        userId,
        email: null,
        optedIn: false,
        promptedAt,
        version,
        skippedAt: null,
        lastPingAt: promptedAt,
      });
      return;
    }

    if (result.state === 'skipped') {
      await pingAnonymous(userId, version, 'cli-firstrun-skip', promptedAt);
      writeConfig({
        userId,
        email: null,
        optedIn: false,
        promptedAt,
        version,
        skippedAt: promptedAt,
        lastPingAt: promptedAt,
      });
      return;
    }

    if (result.state === 'retracted') {
      await pingAnonymous(userId, version, 'cli-firstrun-retraction', promptedAt);
      writeConfig({
        userId,
        email: null,
        optedIn: false,
        promptedAt,
        version,
        skippedAt: null,
        lastPingAt: promptedAt,
      });
      return;
    }

    if (result.state === 'invalid') {
      await pingAnonymous(userId, version, 'cli-firstrun-invalid', promptedAt);
      writeConfig({
        userId,
        email: null,
        optedIn: false,
        promptedAt,
        version,
        skippedAt: null,
        lastPingAt: promptedAt,
      });
      return;
    }

    // state === 'confirmed' — POST the real email.
    const postResult = await postSignup({
      userId,
      email: result.email,
      version,
      source: 'cli-firstrun',
      timestamp: promptedAt,
    });

    const syncStatus = postResult.ok ? 'synced' : 'pending';

    writeConfig({
      userId,
      email: result.email,
      optedIn: true,
      promptedAt,
      version,
      skippedAt: null,
      syncStatus,
      lastPingAt: promptedAt,
    });

    process.stdout.write('\n  Thanks! You are all set. Running Ghost Architect...\n\n');
  } catch (err) {
    if (process.env.GHOST_DEBUG) {
      console.error('[firstRun] error:', err.message);
    }
    // Best-effort anonymous ping so we know something happened.
    await pingAnonymous(userId, version, 'cli-firstrun-error', promptedAt);
    writeConfig({
      userId,
      email: null,
      optedIn: false,
      promptedAt,
      version,
      skippedAt: null,
      error: true,
      lastPingAt: promptedAt,
    });
  } finally {
    rl.close();
    process.removeListener('SIGINT', sigintHandler);
  }
}

// ── Upgrade flow ────────────────────────────────────────────────────────

// Runs once for users who upgraded from a pre-5.3.1 version and whose
// config file at CONFIG_PATH is missing the userId/email fields.
// In practice this path is rarely hit because pre-5.3.1 users used the
// configstore-based wizard which writes to a different file entirely —
// they look like fresh installs to checkFirstRun. But we keep this for
// safety in case future code paths create partial configs.
async function runUpgradePrompt(existing, version) {
  const userId = existing.userId || crypto.randomUUID();
  const upgradePromptedAt = new Date().toISOString();

  const sigintHandler = () => {
    writeConfig({
      ...existing,
      userId,
      email: null,
      optedIn: false,
      upgradePromptedAt,
      version,
      interrupted: true,
      lastPingAt: upgradePromptedAt,
    });
    process.stdout.write('\n');
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const result = await runPrompt(rl, true);

    if (result.state === 'declined') {
      await pingAnonymous(userId, version, 'cli-upgrade-no', upgradePromptedAt);
      writeConfig({
        ...existing,
        userId,
        email: null,
        optedIn: false,
        upgradePromptedAt,
        version,
        lastPingAt: upgradePromptedAt,
      });
      return;
    }

    if (result.state === 'skipped') {
      await pingAnonymous(userId, version, 'cli-upgrade-skip', upgradePromptedAt);
      writeConfig({
        ...existing,
        userId,
        email: null,
        optedIn: false,
        upgradePromptedAt,
        skippedAt: upgradePromptedAt,
        version,
        lastPingAt: upgradePromptedAt,
      });
      return;
    }

    if (result.state === 'retracted') {
      await pingAnonymous(userId, version, 'cli-upgrade-retraction', upgradePromptedAt);
      writeConfig({
        ...existing,
        userId,
        email: null,
        optedIn: false,
        upgradePromptedAt,
        version,
        lastPingAt: upgradePromptedAt,
      });
      return;
    }

    if (result.state === 'invalid') {
      await pingAnonymous(userId, version, 'cli-upgrade-invalid', upgradePromptedAt);
      writeConfig({
        ...existing,
        userId,
        email: null,
        optedIn: false,
        upgradePromptedAt,
        version,
        lastPingAt: upgradePromptedAt,
      });
      return;
    }

    // confirmed
    const postResult = await postSignup({
      userId,
      email: result.email,
      version,
      source: 'cli-upgrade',
      timestamp: upgradePromptedAt,
    });

    const syncStatus = postResult.ok ? 'synced' : 'pending';

    writeConfig({
      ...existing,
      userId,
      email: result.email,
      optedIn: true,
      upgradePromptedAt,
      version,
      syncStatus,
      lastPingAt: upgradePromptedAt,
    });

    process.stdout.write('\n  Thanks! You are all set. Running Ghost Architect...\n\n');
  } catch (err) {
    if (process.env.GHOST_DEBUG) {
      console.error('[firstRun upgrade] error:', err.message);
    }
    await pingAnonymous(userId, version, 'cli-upgrade-error', upgradePromptedAt);
    writeConfig({
      ...existing,
      userId,
      email: null,
      optedIn: false,
      upgradePromptedAt,
      version,
      error: true,
      lastPingAt: upgradePromptedAt,
    });
  } finally {
    rl.close();
    process.removeListener('SIGINT', sigintHandler);
  }
}
