#!/usr/bin/env node
// One-shot: write portal publish config to the local configstore.
// Run from inside the project dir so configstore (ESM) imports cleanly.
//
// Usage: node scripts/set-portal-config.mjs <github-pat>
//   or:  GHOST_REPORTS_PAT=<pat> node scripts/set-portal-config.mjs
import Configstore from 'configstore';

const pat = process.argv[2] || process.env.GHOST_REPORTS_PAT;
if (!pat || !pat.startsWith('ghp_') && !pat.startsWith('github_pat_')) {
  console.error('ERROR: pass a GitHub PAT as the first argument or set GHOST_REPORTS_PAT.');
  console.error('Token should start with "ghp_" (classic) or "github_pat_" (fine-grained).');
  process.exit(1);
}

const config = new Configstore('ghost-architect');
config.set('portalPublish', {
  repo:  'https://github.com/EJWisner/ghost-reports-portal-test',
  token: pat,
  slug:  'ejwisner',
});

const saved = config.get('portalPublish');
const redacted = { ...saved, token: '<redacted>' };
console.log('Portal config saved:');
console.log(JSON.stringify(redacted, null, 2));
