/**
 * Ghost Architect — Agent Tools
 * Fixed, auditable tool set for the ReAct agent loop.
 * The agent can ONLY take actions defined here — no arbitrary execution.
 * Pure functions — no Chalk, no Inquirer, no console output.
 */

import fs   from 'fs';
import path from 'path';

// ── Tool registry ─────────────────────────────────────────────────────────────
// Each tool: { description, inputSchema, execute }

export function buildTools(fileMap, memory) {
  return {

    // ── readFile ──────────────────────────────────────────────────────────────
    // Read full content of a specific file from the loaded codebase

    readFile: {
      description: 'Read the full content of a specific file from the loaded codebase by path.',
      inputSchema: {
        path: 'string — relative path to the file (e.g. src/checkout/Model/Payment.php)',
      },
      execute: async ({ path: filePath }) => {
        // Check memory cache first
        if (memory.hasRead(filePath)) {
          return { cached: true, content: memory.getCached(filePath), path: filePath };
        }
        // Check fileMap (pre-loaded files)
        if (fileMap[filePath]) {
          return { cached: false, content: fileMap[filePath], path: filePath };
        }
        // Fuzzy match — try to find by basename
        const basename = path.basename(filePath);
        const match = Object.keys(fileMap).find(k => path.basename(k) === basename);
        if (match) {
          return { cached: false, content: fileMap[match], path: match, note: `Resolved from ${filePath}` };
        }
        return { error: `File not found: ${filePath}`, availableCount: Object.keys(fileMap).length };
      },
    },

    // ── searchFiles ───────────────────────────────────────────────────────────
    // Search all loaded files for a class name, method, string, or pattern

    searchFiles: {
      description: 'Search all loaded files for a class name, method name, or string pattern. Returns matching file paths and line excerpts.',
      inputSchema: {
        query:  'string — what to search for (class name, method, string, regex pattern)',
        type:   'string — one of: className | method | string | pattern',
        limit:  'number (optional) — max results to return, default 10',
      },
      execute: async ({ query, type = 'string', limit = 10 }) => {
        const results = [];
        const searchTerm = type === 'className'
          ? new RegExp(`class\\s+${escapeRegex(query)}|interface\\s+${escapeRegex(query)}|\\\\${escapeRegex(query)}`, 'i')
          : type === 'method'
          ? new RegExp(`function\\s+${escapeRegex(query)}|${escapeRegex(query)}\\s*\\(`, 'i')
          : type === 'pattern'
          ? new RegExp(query, 'i')
          : new RegExp(escapeRegex(query), 'i');

        for (const [filePath, content] of Object.entries(fileMap)) {
          if (results.length >= limit) break;
          const lines = content.split('\n');
          const matches = [];
          lines.forEach((line, idx) => {
            if (searchTerm.test(line)) {
              matches.push({ line: idx + 1, content: line.trim().slice(0, 120) });
            }
          });
          if (matches.length > 0) {
            results.push({ path: filePath, matches: matches.slice(0, 3) });
          }
        }

        return {
          query,
          type,
          resultCount: results.length,
          results,
          searched: Object.keys(fileMap).length,
        };
      },
    },

    // ── listDirectory ─────────────────────────────────────────────────────────
    // List all files in the loaded codebase under a given path prefix

    listDirectory: {
      description: 'List all files in the loaded codebase under a given directory path. Use to explore module structure.',
      inputSchema: {
        path:      'string — directory prefix to filter by (e.g. src/checkout or app/code/Vendor)',
        maxDepth:  'number (optional) — max directory depth to show, default 3',
      },
      execute: async ({ path: dirPath, maxDepth = 3 }) => {
        const prefix  = dirPath.replace(/\\/g, '/');
        const matches = Object.keys(fileMap)
          .filter(f => f.replace(/\\/g, '/').startsWith(prefix))
          .slice(0, 50);

        // Group by directory
        const tree = {};
        for (const filePath of matches) {
          const rel   = filePath.slice(prefix.length).replace(/^\//, '');
          const parts = rel.split('/');
          if (parts.length <= maxDepth) {
            const dir = parts.slice(0, -1).join('/') || '.';
            if (!tree[dir]) tree[dir] = [];
            tree[dir].push(parts[parts.length - 1]);
          }
        }

        return {
          path:       dirPath,
          fileCount:  matches.length,
          files:      matches.slice(0, 30),
          tree,
        };
      },
    },

    // ── summarizeFile ─────────────────────────────────────────────────────────
    // Extract structural summary — classes, methods, dependencies — without full content

    summarizeFile: {
      description: 'Get a structural summary of a file: class names, method signatures, imports, and key patterns. More efficient than readFile for orientation.',
      inputSchema: {
        path: 'string — relative path to the file',
      },
      execute: async ({ path: filePath }) => {
        const content = fileMap[filePath];
        if (!content) {
          return { error: `File not found: ${filePath}` };
        }

        const lines     = content.split('\n');
        const classes   = [];
        const methods   = [];
        const imports   = [];
        const observers = [];
        const plugins   = [];

        for (const line of lines) {
          const t = line.trim();
          if (/^(class|abstract class|interface)\s+\w+/.test(t))  classes.push(t.slice(0, 100));
          if (/^(public|protected|private|async)?\s*(function)\s+\w+/.test(t)) methods.push(t.slice(0, 100));
          if (/^(import|require|use)\s+/.test(t))                  imports.push(t.slice(0, 100));
          if (/<event\s+name=|<observer\s+/.test(t))               observers.push(t.slice(0, 100));
          if (/<plugin\s+|sortOrder=/.test(t))                     plugins.push(t.slice(0, 100));
        }

        return {
          path:      filePath,
          lineCount: lines.length,
          charCount: content.length,
          classes:   classes.slice(0, 10),
          methods:   methods.slice(0, 15),
          imports:   imports.slice(0, 10),
          observers: observers.slice(0, 5),
          plugins:   plugins.slice(0, 5),
        };
      },
    },

    // ── resolveClass ──────────────────────────────────────────────────────────
    // Find where a class or interface is defined in the loaded codebase

    resolveClass: {
      description: 'Find where a class, interface, or trait is defined in the loaded codebase. Returns file path and line number.',
      inputSchema: {
        className: 'string — fully qualified or short class name to find',
      },
      execute: async ({ className }) => {
        // Check memory cache
        const cached = memory.getResolvedClass(className);
        if (cached) return { path: cached, cached: true };

        // Strip namespace prefix for matching
        const shortName = className.split('\\').pop().split('/').pop();
        const pattern   = new RegExp(`class\\s+${escapeRegex(shortName)}|interface\\s+${escapeRegex(shortName)}`, 'i');

        for (const [filePath, content] of Object.entries(fileMap)) {
          if (pattern.test(content)) {
            const lines = content.split('\n');
            const lineNum = lines.findIndex(l => pattern.test(l)) + 1;
            return { path: filePath, line: lineNum, className, shortName };
          }
        }

        // Try filename match as fallback
        const fileMatch = Object.keys(fileMap).find(f =>
          path.basename(f, path.extname(f)).toLowerCase() === shortName.toLowerCase()
        );
        if (fileMatch) {
          return { path: fileMatch, className, shortName, note: 'Resolved by filename match' };
        }

        return { error: `Class not found: ${className}`, searched: Object.keys(fileMap).length };
      },
    },

    // ── flagFinding ───────────────────────────────────────────────────────────
    // Record a confirmed finding to include in the final report

    flagFinding: {
      description: 'Record a confirmed finding for inclusion in the final report. Use only for confirmed issues, not candidates.',
      inputSchema: {
        severity:    'string — one of: BLOCKING | HIGH | MEDIUM | LOW | INFO',
        title:       'string — short descriptive title for the finding',
        detail:      'string — full explanation: what the issue is, why it matters, what to do',
        files:       'array of strings — file paths involved in this finding',
        confidence:  'number (optional) — 0-100, how confident you are. Default 90.',
      },
      execute: async ({ severity, title, detail, files = [], confidence = 90 }) => {
        const finding = { severity, title, detail, files, confidence };
        memory.addFinding(finding);
        return {
          recorded:    true,
          findingId:   memory.findings.length,
          severity,
          title,
        };
      },
    },

    // ── finish ────────────────────────────────────────────────────────────────
    // Signal that analysis is complete

    finish: {
      description: 'Signal that analysis is complete. Call this when you have found all relevant issues or reached a natural stopping point.',
      inputSchema: {
        summary: 'string — brief summary of what was analyzed and found',
        reason:  'string — why you are finishing: complete | step_cap | insufficient_data',
      },
      execute: async ({ summary, reason = 'complete' }) => {
        return {
          done:    true,
          summary,
          reason,
          results: memory.synthesize(),
        };
      },
    },

  };
}

// ── Helper: escape regex special chars ───────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Tool descriptions for Claude prompt ───────────────────────────────────────
// Produces a compact tool reference to include in the system prompt

export function buildToolDescriptions(tools) {
  return Object.entries(tools).map(([name, tool]) => {
    const schema = Object.entries(tool.inputSchema || {})
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n');
    return `${name}:\n  ${tool.description}\n  Input:\n${schema}`;
  }).join('\n\n');
}
