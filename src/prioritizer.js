/**
 * Ghost Architect — Intelligent File Prioritization v3.0
 * Scores files by likely importance before building passes.
 * High-risk, high-dependency files analyzed first.
 */

// High-risk filename patterns — security, payments, auth, admin
const HIGH_RISK_PATTERNS = [
  /payment/i, /checkout/i, /auth/i, /login/i, /password/i, /token/i,
  /security/i, /admin/i, /permission/i, /role/i, /access/i, /credential/i,
  /encrypt/i, /decrypt/i, /secret/i, /key/i, /cert/i, /ssl/i, /oauth/i,
  /api[_-]?key/i, /webhook/i, /billing/i, /invoice/i, /subscription/i,
];

// Entry point patterns — files everything flows through
const ENTRY_POINT_PATTERNS = [
  /index\.(js|ts|php|py|rb)$/i, /app\.(js|ts|php|py|rb)$/i,
  /main\.(js|ts|php|py|rb|cpp|c)$/i, /bootstrap/i, /kernel/i,
  /router/i, /routes/i, /controller/i, /middleware/i, /handler/i,
  /service/i, /manager/i, /factory/i, /provider/i,
];

// Core architecture patterns
const ARCHITECTURE_PATTERNS = [
  /model/i, /schema/i, /migration/i, /database/i, /config/i,
  /interface/i, /abstract/i, /base/i, /core/i, /foundation/i,
  /repository/i, /store/i, /cache/i, /queue/i, /job/i, /worker/i,
];

export function scoreFile(filePath, content) {
  let score = 0;
  const fileName = filePath.toLowerCase();

  // High-risk patterns — highest weight
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(fileName)) { score += 30; break; }
  }

  // Entry point patterns
  for (const pattern of ENTRY_POINT_PATTERNS) {
    if (pattern.test(fileName)) { score += 20; break; }
  }

  // Architecture patterns
  for (const pattern of ARCHITECTURE_PATTERNS) {
    if (pattern.test(fileName)) { score += 15; break; }
  }

  // Dependency count — files imported by many others score higher
  const importCount = countImports(content);
  score += Math.min(importCount * 2, 20);

  // File size proxy — larger files tend to be more complex/important
  const lines = content.split('\n').length;
  if (lines > 500) score += 10;
  if (lines > 200) score += 5;

  // TODO/FIXME density — more TODOs = more technical debt = more interesting
  const todos = (content.match(/TODO|FIXME|HACK|XXX|BUG/gi) || []).length;
  score += Math.min(todos * 3, 15);

  // Test files — lower priority (they describe behavior, not implement it)
  if (/test|spec|__tests__|\.test\.|\.spec\./i.test(fileName)) score -= 20;

  // Config/lock files — low priority
  if (/package-lock|yarn\.lock|composer\.lock|\.env\.example/i.test(fileName)) score -= 30;

  return Math.max(0, score);
}

function countImports(content) {
  // Count import/require/use/include statements
  const patterns = [
    /^import\s/gm,
    /^from\s+['"].*['"]\s+import/gm,
    /require\s*\(/gm,
    /^use\s+/gm,
    /^include\s*/gm,
    /^require\s+/gm,
    /#include/gm,
  ];
  return patterns.reduce((total, p) => total + (content.match(p) || []).length, 0);
}

export function prioritizeFileMap(fileMap) {
  const scored = Object.entries(fileMap).map(([filePath, content]) => ({
    filePath,
    content,
    score: scoreFile(filePath, content),
  }));

  // Sort by score descending — highest priority files first
  scored.sort((a, b) => b.score - a.score);

  // Return as ordered object
  const prioritized = {};
  for (const { filePath, content } of scored) {
    prioritized[filePath] = content;
  }

  return prioritized;
}

export function getTopFiles(fileMap, n = 10) {
  const scored = Object.entries(fileMap).map(([filePath, content]) => ({
    filePath,
    score: scoreFile(filePath, content),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}
