import fs from 'fs';
import path from 'path';

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

export function generateBrief({ findings, ghostVersion, scanFile, codemaseRoot }) {
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
    source: {
      scan_mode: sourceMeta.scan_mode,
      ...(sourceMeta.contributing_modes ? { contributing_modes: sourceMeta.contributing_modes } : {}),
      scan_file: scanFile || 'unknown',
      codebase_root: codemaseRoot || process.cwd()
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

export function writeBrief(brief, outputPath) {
  const outPath = outputPath || path.join(process.cwd(), 'ghost-brief.json');
  fs.writeFileSync(outPath, JSON.stringify(brief, null, 2), 'utf8');
  return outPath;
}
