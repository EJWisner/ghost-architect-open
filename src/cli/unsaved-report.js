// src/cli/unsaved-report.js
//
// What to do with a finished report the user declined to save.
//
// POI, Blast and Conflict all buffer their report rather than streaming it, then
// ask "Save this report?" AFTER the scan has run and the cost line has already
// been printed. The work is done. The money is spent. Answering "no" used to
// drop the buffer on the floor: Blast printed "(Report not saved.)", Conflict
// printed nothing at all, and in both cases the only copy of an analysis the
// customer just paid for ceased to exist.
//
// "No" almost never means "destroy it". It means "don't add this to my saved
// reports". So we write the buffer to a clearly-named file in the reports
// directory and hand back the path.
//
// We do NOT print the buffer to the terminal. A POI run on a large repo is
// thousands of lines of markdown; dumping that into a scrollback buffer is not
// a way to read a report, and on a small terminal it destroys the cost line and
// the verification summary the user just paid attention to. A path they can
// open is strictly more useful than a wall of text they cannot scroll back
// through.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ensureReportsDir } from '../reports.js';

// Hand a file to the platform's default viewer. Never throws: a headless box,
// a stripped container, an SSH session with no DISPLAY, or a locked-down
// corporate desktop are all completely normal and none of them are an error
// worth interrupting the user over. Returns true only when the launcher
// actually started and exited cleanly.
function openInSystemViewer(filePath) {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'darwin') {
      cmd = 'open';  args = [filePath];
    } else if (process.platform === 'win32') {
      // The empty string is `start`'s title argument. Without it, a quoted path
      // is consumed AS the window title and nothing opens.
      cmd = 'cmd';   args = ['/c', 'start', '', filePath];
    } else {
      cmd = 'xdg-open'; args = [filePath];
    }

    let child;
    try {
      // No shell: the path goes through as a single argv entry, so spaces and
      // shell metacharacters in the reports directory cannot be interpreted.
      child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };

    // ENOENT: no `xdg-open` on this box, no `open` on this platform.
    child.once('error', () => settle(false));
    child.once('exit', (code) => settle(code === 0));

    // Some launchers (certain xdg-open shims) stay in the foreground for the
    // life of the viewer. Don't hang the CLI on them: give the launcher a
    // moment to fail fast, then assume it worked and detach.
    setTimeout(() => {
      if (!settled) {
        try { child.unref(); } catch { /* already gone */ }
        settle(true);
      }
    }, 400);
  });
}

/**
 * Persist a report the user declined to save, and offer to open it.
 *
 * @param {string} buffer  the finished report text
 * @param {object} opts    { prefix } e.g. 'ghost-poi', used in the filename
 * @returns {Promise<string|null>} the path written, or null
 */
export async function offerUnsavedReport(buffer, opts = {}) {
  if (!buffer || !buffer.trim()) {
    console.log(chalk.gray('\n  (No report was produced.)\n'));
    return null;
  }

  const prefix = opts.prefix || 'ghost-report';

  let filePath;
  try {
    const dir = ensureReportsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    filePath = path.join(dir, `${prefix}-unsaved-${timestamp}.md`);
    fs.writeFileSync(filePath, buffer, 'utf8');
  } catch (err) {
    // Disk full, read-only home, permissions. Say so plainly rather than
    // pretending the report survived.
    console.log(chalk.red(`\n  Could not write the unsaved report: ${err.message}`));
    console.log(chalk.gray('  The analysis ran and was billed, but could not be preserved.\n'));
    return null;
  }

  console.log(chalk.yellow('\n  This analysis has already run, and you have been billed for it.'));
  console.log(chalk.white('  It was written to:'));
  console.log(chalk.cyan(`  ${filePath}\n`));

  let open = false;
  try {
    ({ open } = await inquirer.prompt([{
      type: 'confirm',
      name: 'open',
      message: chalk.cyan('Open it now?'),
      default: false,
    }]));
  } catch (_) {
    // Prompt threw (non-TTY stdin, closed stream). The file is already on disk
    // and the path is already printed, so there is nothing to recover.
    return filePath;
  }

  if (!open) {
    console.log(chalk.gray('  Left on disk at the path above.\n'));
    return filePath;
  }

  const opened = await openInSystemViewer(filePath);
  if (!opened) {
    console.log(chalk.gray('\n  Could not launch a viewer on this system. Open the path above manually.\n'));
  } else {
    console.log(chalk.gray('  Opened in your default viewer.\n'));
  }
  return filePath;
}
