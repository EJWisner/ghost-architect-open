import fs from 'fs';
import path from 'path';
import os from 'os';
import { formatTransportFooter } from '../src/lib/transport-meta.js';

const SCHEMA_VERSION = '1.0.0';
const BLAST_SCORE_THRESHOLDS = { surgical: 15, moderate: 40 };
const AVG_HOURS_PER_PROMPT = 0.25;

export function blastLabel(score) {
  if (score <= BLAST_SCORE_THRESHOLDS.surgical) return 'surgical';
  if (score <= BLAST_SCORE_THRESHOLDS.moderate) return 'moderate';
  return 'broad';
}

function buildSummary(prompts) {
  const by_severity = { critical: 0, high: 0, medium: 0, low: 0 };
  const by_blast_radius = { surgical: 0, moderate: 0, broad: 0 };

  for (const p of prompts) {
    if (by_severity[p.severity] !== undefined) by_severity[p.severity]++;
    if (by_blast_radius[p.blast_radius] !== undefined) by_blast_radius[p.blast_radius]++;
  }

  return {
    total_prompts: prompts.length,
    by_severity,
    by_blast_radius,
    estimated_agent_hours: parseFloat((prompts.length * AVG_HOURS_PER_PROMPT).toFixed(2))
  };
}

function detectSourceMeta(findings) {
  const modes = [...new Set(findings.map(f => f.source_mode).filter(Boolean))];
  if (modes.length === 0) return { scan_mode: 'unknown', contributing_modes: undefined };
  if (modes.length === 1) return { scan_mode: modes[0], contributing_modes: undefined };
  return { scan_mode: 'multi', contributing_modes: modes };
}

export function validatePrompt(p, index) {
  const errors = [];
  if (!p.id) errors.push(`prompts[${index}]: missing id`);
  if (!p.title) errors.push(`prompts[${index}]: missing title`);
  if (!['critical','high','medium','low'].includes(p.severity)) errors.push(`prompts[${index}]: invalid severity`);
  if (!['surgical','moderate','broad'].includes(p.blast_radius)) errors.push(`prompts[${index}]: invalid blast_radius`);
  if (typeof p.blast_score !== 'number') errors.push(`prompts[${index}]: blast_score must be a number`);
  if (!p.prompt || p.prompt.trim().length === 0) errors.push(`prompts[${index}]: prompt text is empty`);
  if (!Array.isArray(p.validation_hints) || p.validation_hints.length === 0) errors.push(`prompts[${index}]: validation_hints required (min 1)`);
  if (!p.files || !Array.isArray(p.files.primary) || p.files.primary.length === 0) errors.push(`prompts[${index}]: files.primary required`);
  return errors;
}

export function validateBrief(brief) {
  const errors = [];
  if (!brief.schema_version) errors.push('missing schema_version');
  if (!brief.prompts || !Array.isArray(brief.prompts)) errors.push('missing prompts array');
  else brief.prompts.forEach((p, i) => errors.push(...validatePrompt(p, i)));
  return errors;
}

// @ghost-verified: all callers verified to use codebaseRoot (correct spelling) -- codemaseRoot typo was fixed in v9.4.7 across all call sites including watcher-commit.js
export function generateBrief({ findings, ghostVersion, scanFile, codebaseRoot, tier }) {
  if (!findings || findings.length === 0) {
    throw new Error('Ghost Brief: findings array is empty — nothing to generate.');
  }

  // Sort by blast_score ascending (surgical first)
  const sorted = [...findings].sort((a, b) => (a.blast_score || 0) - (b.blast_score || 0));

  // Ensure blast_radius label is consistent with score
  const prompts = sorted.map(f => ({
    ...f,
    blast_radius: blastLabel(f.blast_score || 0)
  }));

  const sourceMeta = detectSourceMeta(findings);

  const brief = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    ghost_version: ghostVersion,
    tier: tier || 'open',
    source: {
      scan_mode: sourceMeta.scan_mode,
      ...(sourceMeta.contributing_modes ? { contributing_modes: sourceMeta.contributing_modes } : {}),
      scan_file: scanFile || 'unknown',
      codebase_root: codebaseRoot || process.cwd()
    },
    summary: buildSummary(prompts),
    prompts
  };

  const errors = validateBrief(brief);
  if (errors.length > 0) {
    throw new Error('Ghost Brief validation failed:\n' + errors.join('\n'));
  }

  return brief;
}

// ── HTML report renderer ─────────────────────────────────────────────────────
//
// Produces a single self-contained ghost-brief.html: no external CSS, no JS
// libraries, no server. Opens in any browser. Dark theme matching the Ghost
// portal aesthetic.

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// Per-prompt effort estimate is embedded in the prompt text as
// "ESTIMATED EFFORT: 6 hours". Pull it out for the card chip; fall back to a
// dash when the generator did not include one.
function extractEffort(prompt) {
  const text = prompt && prompt.prompt ? prompt.prompt : '';
  const m = text.match(/ESTIMATED EFFORT:\s*([^\n]+)/i);
  return m ? m[1].trim() : '—';
}

// The CONTEXT block is embedded in the generated prompt text between
// "CONTEXT:" and the next section header. Pull it out for the card's context
// paragraph; return '' when the generator did not include one.
function extractContext(prompt) {
  const text = prompt && prompt.prompt ? prompt.prompt : '';
  const m = text.match(/CONTEXT:\s*([\s\S]*?)\n\s*(?:FIX STEPS:|CONSTRAINTS:|CONFIDENCE:|ESTIMATED EFFORT:|$)/i);
  if (!m) return '';
  return m[1].replace(/^\*+\s*/, '').trim();
}

export function renderBriefHtml(brief, branding) {
  const summary = brief.summary || {};
  const bySev = summary.by_severity || {};
  const byBlast = summary.by_blast_radius || {};
  const source = brief.source || {};
  const prompts = Array.isArray(brief.prompts) ? brief.prompts : [];

  // Cards / sequence sorted by blast_score ascending (surgical first).
  const ordered = [...prompts].sort((a, b) => (a.blast_score || 0) - (b.blast_score || 0));

  const tier = brief.tier || source.tier || '—';
  const codebaseRoot = source.codebase_root || 'unknown';

  // Transport footer line — how the underlying scan reached the model
  // (streaming vs batch). Rendered only when brief.transport is present.
  const transportFooter = formatTransportFooter(brief.transport);
  const total = summary.total_prompts != null ? summary.total_prompts : prompts.length;
  const estHours = summary.estimated_agent_hours != null ? summary.estimated_agent_hours : '—';

  const summaryCards = `
        <div class="sumcard total">
          <div class="sum-num">${esc(total)}</div>
          <div class="sum-label">Total Prompts</div>
        </div>
        <div class="sumcard critical">
          <div class="sum-num">${esc(bySev.critical || 0)}</div>
          <div class="sum-label">Critical</div>
        </div>
        <div class="sumcard high">
          <div class="sum-num">${esc(bySev.high || 0)}</div>
          <div class="sum-label">High</div>
        </div>
        <div class="sumcard hours">
          <div class="sum-num">${esc(estHours)}</div>
          <div class="sum-label">Est. Agent Hours</div>
        </div>
        <div class="sumcard blast">
          <div class="sum-label">Blast Radius</div>
          <div class="blast-rows">
            <span class="brow"><span class="dot surgical"></span>${esc(byBlast.surgical || 0)} surgical</span>
            <span class="brow"><span class="dot moderate"></span>${esc(byBlast.moderate || 0)} moderate</span>
            <span class="brow"><span class="dot broad"></span>${esc(byBlast.broad || 0)} broad</span>
          </div>
        </div>`;

  const sequence = ordered.map((p, i) => `
            <li class="chip">
              <span class="chip-num">${i + 1}</span>
              <span class="chip-title">${esc(p.title || p.id || 'Untitled')}</span>
            </li>`).join('');

  const cards = ordered.map((p, i) => {
    const primary = (p.files && Array.isArray(p.files.primary)) ? p.files.primary : [];
    const hints = Array.isArray(p.validation_hints) ? p.validation_hints : [];
    const sev = p.severity || 'low';
    const blast = p.blast_radius || 'surgical';
    const effort = extractEffort(p);
    const context = extractContext(p);
    return `
        <details class="card blast-${esc(blast)}"${i === 0 ? ' open' : ''}>
          <summary class="card-head">
            <span class="prio">${i + 1}</span>
            <span class="card-headtext">
              <span class="card-title">${esc(p.title || p.id || 'Untitled')}</span>
              <span class="card-files">${primary.map(f => esc(f)).join(', ') || 'no files listed'}</span>
            </span>
            <span class="card-meta">
              <span class="badge sev-${esc(sev)}">${esc(sev)}</span>
              <span class="badge blastbadge-${esc(blast)}">${esc(blast)}</span>
              <span class="effort">${esc(effort)}</span>
              <span class="chevron">&rsaquo;</span>
            </span>
          </summary>
          <div class="card-body">
            ${context ? `<p class="context">${esc(context)}</p>` : ''}
            <div class="prompt-label-row">
              <span class="prompt-label">Prompt</span>
              <button class="copy-btn" type="button" onclick="
                var pre = this.closest('.card-body').querySelector('pre.prompt');
                var btn = this;
                var done = function(){ btn.classList.add('copied'); btn.textContent = 'Copied!'; setTimeout(function(){ btn.classList.remove('copied'); btn.textContent = 'Copy'; }, 2000); };
                var txt = pre.innerText;
                if (navigator.clipboard &amp;&amp; navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(txt).then(done, function(){
                    var r = document.createRange(); r.selectNodeContents(pre);
                    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                    try { document.execCommand('copy'); done(); } catch(e){} s.removeAllRanges();
                  });
                } else {
                  var r = document.createRange(); r.selectNodeContents(pre);
                  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                  try { document.execCommand('copy'); done(); } catch(e){} s.removeAllRanges();
                }
              ">Copy</button>
            </div>
            <pre class="prompt">${esc(p.prompt || '')}</pre>
            ${hints.length ? `
            <div class="hints">
              <div class="hints-label">Validation hints</div>
              <ul>${hints.map(h => `<li>${esc(h)}</li>`).join('')}</ul>
            </div>` : ''}
          </div>
        </details>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ghost Brief™ — ${esc(codebaseRoot)}</title>
<style>
  :root {
    --bg: #0a0d12;
    --card: #0d1117;
    --border: #1e2535;
    --orange: #e07340;
    --green: #22c55e;
    --red: #ef4444;
    --high: #f97316;
    --medium: #eab308;
    --text: #ffffff;
    --text2: #6b7280;
    --dim: #4b5563;
    --vdim: #2a3040;
    --code-bg: #060810;
    --mono: "SF Mono", "Fira Code", "Courier New", monospace;
    --impact: Impact, "Haettenschweiler", "Arial Narrow Bold", sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif;
  }
  a { color: var(--orange); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ── Sticky header ── */
  header.sticky {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 14px;
    padding: 14px 24px;
    background: rgba(10,13,18,0.94);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }
  .logo {
    width: 38px; height: 38px; flex: 0 0 38px;
    display: grid; place-items: center;
    border: 2px solid var(--orange); border-radius: 8px;
    color: var(--orange); font-family: var(--impact); font-size: 22px; line-height: 1;
  }
  .htitle { font-weight: 700; font-size: 15px; white-space: nowrap; }
  .hpath { color: var(--text2); font-family: var(--mono); font-size: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 40px; }
  .hbadges { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
  .hbadge { font-size: 11px; padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--text2); white-space: nowrap; font-family: var(--mono); }
  .hbadge.tier { color: var(--orange); border-color: var(--orange); }
  .hbadge.count { color: var(--text); }

  main { max-width: 1080px; margin: 0 auto; padding: 26px 24px 56px; }

  /* ── Summary grid ── */
  .summary {
    display: grid; grid-template-columns: repeat(5, 1fr);
    gap: 12px; margin-bottom: 24px;
  }
  .sumcard {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 16px;
  }
  .sum-num { font-family: var(--impact); font-size: 34px; line-height: 1; color: var(--text); }
  .sum-label { color: var(--text2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 10px; }
  .sumcard.total .sum-num { color: var(--orange); }
  .sumcard.critical .sum-num { color: var(--red); }
  .sumcard.high .sum-num { color: var(--orange); }
  .sumcard.hours .sum-num { color: var(--text); }
  .sumcard.blast .sum-label { margin-top: 0; margin-bottom: 10px; color: var(--green); }
  .blast-rows { display: flex; flex-direction: column; gap: 6px; }
  .brow { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text); }
  .dot { width: 8px; height: 8px; border-radius: 999px; flex: 0 0 8px; }
  .dot.surgical { background: var(--orange); }
  .dot.moderate { background: var(--medium); }
  .dot.broad { background: var(--red); }

  /* ── Start here banner ── */
  .starthere {
    background: var(--card); border: 1px solid var(--border);
    border-left: 3px solid var(--orange); border-radius: 10px;
    padding: 16px 18px; margin-bottom: 28px;
  }
  .starthere-label { font-family: var(--mono); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--orange); margin-bottom: 12px; }
  .chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 6px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 999px; max-width: 100%; }
  .chip-num { display: grid; place-items: center; width: 20px; height: 20px; flex: 0 0 20px;
    border-radius: 999px; background: var(--orange); color: var(--bg); font-size: 11px; font-weight: 700; font-family: var(--mono); }
  .chip-title { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 340px; color: var(--text); }

  /* ── Effort note ── */
  .effort-note { color: var(--dim); font-size: 13px; font-style: italic; padding: 0 40px; margin: 0 0 8px; }

  /* ── Section label ── */
  .section-label { font-family: var(--mono); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.12em; color: var(--dim); margin: 0 0 14px; }

  /* ── Prompt cards ── */
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-left: 3px solid var(--vdim);
    border-radius: 10px; margin-bottom: 10px; overflow: hidden;
  }
  .card.blast-surgical { border-left-color: var(--orange); }
  .card.blast-moderate { border-left-color: var(--medium); }
  .card.blast-broad { border-left-color: var(--red); }
  .card-head {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 16px; cursor: pointer; list-style: none;
  }
  .card-head::-webkit-details-marker { display: none; }
  .card-head:hover { background: rgba(255,255,255,0.02); }
  .prio {
    display: grid; place-items: center; width: 28px; height: 28px; flex: 0 0 28px;
    border-radius: 999px; border: 1px solid var(--border);
    color: var(--text2); font-family: var(--mono); font-weight: 700; font-size: 13px;
  }
  .card.blast-surgical .prio { color: var(--orange); border-color: var(--orange); }
  .card.blast-moderate .prio { color: var(--medium); border-color: var(--medium); }
  .card.blast-broad .prio { color: var(--red); border-color: var(--red); }
  .card-headtext { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .card-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-files { color: var(--text2); font-size: 12px; font-family: var(--mono);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .card-meta { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--border); text-transform: capitalize; white-space: nowrap; }
  .badge.sev-critical { color: var(--red); border-color: var(--red); background: rgba(239,68,68,0.10); }
  .badge.sev-high { color: var(--high); border-color: var(--high); background: rgba(249,115,22,0.10); }
  .badge.sev-medium { color: var(--medium); border-color: var(--medium); background: rgba(234,179,8,0.10); }
  .badge.sev-low { color: var(--green); border-color: var(--green); background: rgba(34,197,94,0.10); }
  .badge.blastbadge-surgical { color: var(--orange); border-color: var(--orange); background: rgba(224,115,64,0.10); }
  .badge.blastbadge-moderate { color: var(--medium); border-color: var(--medium); background: rgba(234,179,8,0.10); }
  .badge.blastbadge-broad { color: var(--red); border-color: var(--red); background: rgba(239,68,68,0.10); }
  .effort { font-size: 12px; color: var(--text2); font-family: var(--mono); white-space: nowrap; }
  .chevron { color: var(--dim); font-size: 20px; line-height: 1; transition: transform 0.15s ease;
    display: inline-block; transform: rotate(0deg); }
  .card[open] .chevron { transform: rotate(90deg); }

  .card-body { padding: 4px 18px 18px 18px; }
  .context { color: var(--text2); font-size: 13px; line-height: 1.6; margin: 6px 0 16px; }
  .prompt-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .prompt-label { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--dim); }
  .copy-btn {
    background: var(--orange); color: #fff; border: none;
    border-radius: 7px; padding: 5px 14px; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .copy-btn:hover { filter: brightness(1.08); }
  .copy-btn.copied { background: var(--green); }
  pre.prompt {
    margin: 0; padding: 16px;
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 10px;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.6; color: #cdd3de;
    white-space: pre-wrap; word-break: break-word; overflow-x: auto;
  }
  .hints { margin-top: 16px; }
  .hints-label { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--dim); margin-bottom: 8px; }
  .hints ul { margin: 0; padding: 0; list-style: none; }
  .hints li { position: relative; padding-left: 22px; margin: 6px 0; color: var(--text); }
  .hints li::before { content: "\\2713"; position: absolute; left: 0; top: 0; color: var(--green); font-weight: 700; }

  footer { max-width: 1080px; margin: 0 auto; padding: 22px 24px; color: var(--text2);
    font-size: 12px; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
  footer .grow { flex: 1; }

  @media (max-width: 820px) {
    .summary { grid-template-columns: repeat(2, 1fr); }
    .card-files, .effort { display: none; }
  }
</style>
</head>
<body>
  <header class="sticky">
    <div class="logo">${branding ? esc(branding.companyName).charAt(0).toUpperCase() : 'G'}</div>
    <div class="htitle">${branding ? esc(branding.companyName) + ' Brief' : 'Ghost Brief™'}</div>
    <div class="hpath">${esc(codebaseRoot)}</div>
    <div class="hbadges">
      <span class="hbadge">v${esc(brief.ghost_version || '—')}</span>
      <span class="hbadge tier">${esc(tier)}</span>
      <span class="hbadge count">${esc(total)} prompts</span>
    </div>
  </header>

  <main>
    <section class="summary">${summaryCards}
    </section>

    <p class="effort-note">Effort and cost estimates reflect manual remediation at senior architect rates ($200/hr). AI-assisted execution with Claude Code, Cursor, or your approved coding agent typically reduces actual time by 80&ndash;90%.</p>

    <div class="starthere">
      <div class="starthere-label">Start here · recommended sequence</div>
      <ol class="chips">${sequence || '<li class="chip"><span class="chip-title">No prompts</span></li>'}
      </ol>
    </div>

    <p class="section-label">Prompts</p>
    ${cards || '<p style="color:var(--text2)">No prompts in this brief.</p>'}
  </main>

  <footer>
    <span class="grow">Generated ${esc(formatDate(brief.generated_at))} · Ghost Architect™ v${esc(brief.ghost_version || '—')}</span>
    <a href="https://ghostarchitect.dev" target="_blank" rel="noopener">${branding ? esc(branding.footerText) : 'ghostarchitect.dev'}</a>
    ${transportFooter ? `<span class="transport" style="flex-basis:100%;color:var(--text2)">${esc(transportFooter)}</span>` : ''}
  </footer>
</body>
</html>`;
}

export function writeBrief(brief, outputPath, branding) {
  const jsonPath = outputPath || path.join(process.cwd(), 'ghost-brief.json');
  fs.writeFileSync(jsonPath, JSON.stringify(brief, null, 2), 'utf8');

  // HTML report lands in ~/Ghost Architect Reports/ (same convention as
  // src/reports.js), not alongside the JSON in the working directory.
  const reportsDir = path.join(os.homedir(), 'Ghost Architect Reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const htmlPath = path.join(reportsDir, 'ghost-brief.html');
  fs.writeFileSync(htmlPath, renderBriefHtml(brief, branding), 'utf8');

  return { jsonPath, htmlPath };
}
