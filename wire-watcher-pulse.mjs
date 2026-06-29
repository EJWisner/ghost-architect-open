import { createOctokit } from './src/utils/octokit-client.js';
import { getPortalConfig } from './src/core/portal-publish.js';

const cfg = getPortalConfig();
const octokit = createOctokit({ auth: cfg.token });

const { data } = await octokit.rest.repos.getContent({
  owner: 'EJWisner', repo: 'ghostarchitect.dev', path: 'pulse-x7k2m9.html'
});
let html = Buffer.from(data.content, 'base64').toString('utf8');
const sha = data.sha;

// 1. Insert watcherPromise block before airtablePromise
const ANCHOR = `      const airtablePromise = (async () => {`;
const watcherBlock = `      const watcherPromise = (async () => {
        try {
          await new Promise(r => setTimeout(r, 1000));
          const w = await fetchWatcherStats();
          renderWatcherStats(w);
        } catch (err) {
          renderWatcherError();
        }
      })();

`;

if (!html.includes('const watcherPromise')) {
  html = html.replace(ANCHOR, watcherBlock + ANCHOR);
  console.log('watcherPromise block inserted before airtablePromise');
} else {
  console.log('watcherPromise already present — skipping insert');
}

// 2. Wire await watcherPromise after await npmPromise
const NPM_AWAIT = `        await npmPromise;`;
const NPM_AWAIT_WITH_WATCHER = `        await npmPromise;
        await watcherPromise;`;

if (!html.includes('await watcherPromise;')) {
  html = html.replace(NPM_AWAIT, NPM_AWAIT_WITH_WATCHER);
  console.log('await watcherPromise wired after await npmPromise');
} else {
  console.log('await watcherPromise already present — skipping');
}

// Push
await octokit.rest.repos.createOrUpdateFileContents({
  owner: 'EJWisner', repo: 'ghostarchitect.dev',
  path: 'pulse-x7k2m9.html',
  message: 'fix: wire watcherPromise into tick() with 1s delay',
  content: Buffer.from(html).toString('base64'),
  sha,
});

console.log('Pushed pulse-x7k2m9.html to ghostarchitect.dev');
