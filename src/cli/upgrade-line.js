// src/cli/upgrade-line.js
//
// The one upgrade line Ghost Open™ shows. Printed (dim) in the terminal once
// per saved report, and written as the last line of the Markdown and PDF
// report footers. Keep this the single source of the wording.

import chalk from 'chalk';

export const UPGRADE_LINE =
  'Ghost Open™ is free for one person. For deeper scans, teams and your own AI model on your own hardware: Ghost Architect™ Local 8 (early access beta): ghostarchitect.dev/beta.html';

/** Print the upgrade line, dim gray, on its own line. */
export function printUpgradeLine() {
  console.log(chalk.gray(UPGRADE_LINE));
}
