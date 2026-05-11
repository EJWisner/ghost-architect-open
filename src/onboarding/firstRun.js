// src/onboarding/firstRun.js
//
// Ghost Architect Open — first-run email capture.
//
// Runs once per machine on the initial CLI invocation. The goal is to
// turn anonymous npm installs into an owned email list so we can
// communicate with users about updates, Pro features, and pilots.
//
// Design principles:
//   1. Fully optional. Three states (Y/N/S), default-to-yes UX.
//   2. Graceful failure. Network errors, parse errors, signal
//      interrupts — none of them block the CLI startup.
//   3. Once per machine. Config persists at ~/.ghost-architect/
//      and is checked before any prompt logic runs.
//   4. Privacy-first. Clear disclosure, no hidden tracking, easy
//      opt-out via Ctrl+C or the "No" option.
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

function postSignup(payload) {
  return new Promise((resolve) => {
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

// ── Prompt UI ───────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function printWelcome() {
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

// ── Retry pending sync on later runs ────────────────────────────────────

async function retryPendingSync(config) {
  if (!config) return;
  if (config.syncStatus !== 'pending') return;
  if (!config.email) return;

  const result = await postSignup({
    userId: config.userId,
    email: config.email,
    version: config.version,
    source: 'cli-firstrun-retry',
    timestamp: config.promptedAt,
  });

  if (result.ok) {
    writeConfig({ ...config, syncStatus: 'synced' });
  }
  // If still failing, leave syncStatus as 'pending' — we'll retry on the
  // next run. No exponential backoff needed; CLI runs are infrequent
  // enough that a daily retry is fine.
}

// ── Main entry point ────────────────────────────────────────────────────

export async function checkFirstRun(version) {
  // If config already exists, check for pending sync and exit.
  if (configExists()) {
    const existing = readConfig();
    await retryPendingSync(existing);
    return;
  }

  const userId = crypto.randomUUID();
  const promptedAt = new Date().toISOString();

  // Handle Ctrl+C during prompt. Write a "declined-via-interrupt"
  // config so the prompt doesn't re-fire forever, then exit cleanly.
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
    printWelcome();
    const answer = (await ask(rl, '> ')).toLowerCase();

    // No → decline outright. Never prompt again.
    if (answer === 'n' || answer === 'no') {
      writeConfig({
        userId,
        email: null,
        optedIn: false,
        promptedAt,
        version,
        skippedAt: null,
      });
      process.stdout.write('\n  No problem. Running Ghost Architect...\n\n');
      return;
    }

    // Skip → save with skippedAt timestamp. Future major-version bumps
    // could choose to re-prompt skipped users (not implemented yet).
    if (answer === 's' || answer === 'skip') {
      writeConfig({
        userId,
        email: null,
        optedIn: false,
        promptedAt,
        version,
        skippedAt: promptedAt,
      });
      process.stdout.write('\n  No problem. Running Ghost Architect...\n\n');
      return;
    }

    // Y, yes, or empty (Enter) → proceed to email prompt.
    // User has committed; we don't show "press Enter to skip" because
    // the upfront [N]/[S] choices already covered the decline path.
    process.stdout.write('\n  Email address:\n');
    const emailRaw = await ask(rl, '> ');

    // Empty email after saying yes → quiet retraction. They changed their
    // mind. Save the same shape as the No path so the prompt never re-fires
    // and we don't claim they opted in when they didn't.
    if (emailRaw === '') {
      writeConfig({
        userId,
        email: null,
        optedIn: false,
        promptedAt,
        version,
        skippedAt: null,
      });
      process.stdout.write('\n  No problem. Running Ghost Architect...\n\n');
      return;
    }

    // Invalid email syntax → same as empty. They tried but didn't give us
    // a real address, so we don't record an opt-in. Quiet retraction.
    if (!EMAIL_REGEX.test(emailRaw)) {
      process.stdout.write('\n  Doesn\'t look like a valid email, skipping.\n');
      writeConfig({
        userId,
        email: null,
        optedIn: false,
        promptedAt,
        version,
        skippedAt: null,
      });
      process.stdout.write('  Running Ghost Architect...\n\n');
      return;
    }

    const email = emailRaw;

    // POST to signup endpoint. Failure is fine — we save locally either
    // way and retry on next run if syncStatus is 'pending'.
    const result = await postSignup({
      userId,
      email,
      version,
      source: 'cli-firstrun',
      timestamp: promptedAt,
    });

    const syncStatus = result.ok ? 'synced' : 'pending';

    writeConfig({
      userId,
      email,
      optedIn: true,
      promptedAt,
      version,
      skippedAt: null,
      syncStatus,
    });

    process.stdout.write('\n  Thanks! You are all set. Running Ghost Architect...\n\n');
  } catch (err) {
    // Catch-all — never break CLI startup over the prompt.
    if (process.env.GHOST_DEBUG) {
      console.error('[firstRun] error:', err.message);
    }
    // Best-effort config write so we don't re-prompt forever.
    writeConfig({
      userId,
      email: null,
      optedIn: false,
      promptedAt,
      version,
      skippedAt: null,
      error: true,
    });
  } finally {
    rl.close();
    process.removeListener('SIGINT', sigintHandler);
  }
}
