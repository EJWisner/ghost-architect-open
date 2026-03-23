import chalk from 'chalk';


// ── Stateful parsers for complex patterns (immune to ReDoS) ──────────────────

function parseKeyBlocks(content, beginPattern, endMarker, replacement) {
  let result   = content;
  let offset   = 0;
  let safetyLimit = 100; // max blocks to redact per file

  while (safetyLimit-- > 0) {
    const beginIdx = result.indexOf(beginPattern, offset);
    if (beginIdx === -1) break;

    const searchFrom = beginIdx + beginPattern.length;
    const endIdx     = result.indexOf(endMarker, searchFrom);

    if (endIdx === -1) {
      // No closing marker — stop to avoid runaway
      break;
    }

    const blockEnd = endIdx + endMarker.length;
    const blockLen = blockEnd - beginIdx;

    // Skip implausibly large blocks (>12KB is not a real key)
    if (blockLen > 12000) {
      offset = beginIdx + 1;
      continue;
    }

    result = result.slice(0, beginIdx) + replacement + result.slice(blockEnd);
    // Don't advance offset — replacement is shorter, recheck from same position
  }

  return result;
}

function parsePrivateKeyBlocks(content) {
  // Handle all variants: RSA PRIVATE KEY, EC PRIVATE KEY, PRIVATE KEY, etc.
  const variants = [
    { begin: '-----BEGIN RSA PRIVATE KEY-----',     end: '-----END RSA PRIVATE KEY-----' },
    { begin: '-----BEGIN EC PRIVATE KEY-----',      end: '-----END EC PRIVATE KEY-----' },
    { begin: '-----BEGIN DSA PRIVATE KEY-----',     end: '-----END DSA PRIVATE KEY-----' },
    { begin: '-----BEGIN PRIVATE KEY-----',          end: '-----END PRIVATE KEY-----' },
    { begin: '-----BEGIN ENCRYPTED PRIVATE KEY-----', end: '-----END ENCRYPTED PRIVATE KEY-----' },
    { begin: '-----BEGIN OPENSSH PRIVATE KEY-----', end: '-----END OPENSSH PRIVATE KEY-----' },
  ];
  let result = content;
  for (const { begin, end } of variants) {
    result = parseKeyBlocks(result, begin, end, '[REDACTED:PRIVATE_KEY_BLOCK]');
  }
  return result;
}

function parseCertificateBlocks(content) {
  return parseKeyBlocks(content, '-----BEGIN CERTIFICATE-----', '-----END CERTIFICATE-----', '[REDACTED:CERTIFICATE_BLOCK]');
}

// Patterns to detect and redact sensitive data
const REDACTION_RULES = [
  // API Keys & Tokens — specific service patterns (high confidence, low false positive)
  { name: 'Anthropic API Key',     regex: /sk-ant-[a-zA-Z0-9\-_]{20,}/g,                         replacement: '[REDACTED:ANTHROPIC_KEY]' },
  { name: 'AWS Access Key',        regex: /AKIA[0-9A-Z]{16}/g,                                    replacement: '[REDACTED:AWS_ACCESS_KEY]' },
  { name: 'AWS Secret Key',        regex: /(?<=["'\s])[a-zA-Z0-9/+=]{40}(?=["'\s])/g,             replacement: '[REDACTED:AWS_SECRET]' },
  { name: 'GitHub Token',          regex: /gh[ps]_[a-zA-Z0-9]{36,}/g,                             replacement: '[REDACTED:GITHUB_TOKEN]' },
  { name: 'Stripe Key',            regex: /sk_(live|test)_[a-zA-Z0-9]{24,}/g,                     replacement: '[REDACTED:STRIPE_KEY]' },
  { name: 'Twilio Key',            regex: /SK[a-f0-9]{32}/g,                                      replacement: '[REDACTED:TWILIO_KEY]' },
  { name: 'JWT Token',             regex: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g, replacement: '[REDACTED:JWT_TOKEN]' },

  // Database connection strings — specific DSN format (low false positive)
  { name: 'MySQL DSN',             regex: /mysql:\/\/[^@\s]+:[^@\s]+@/gi,                         replacement: 'mysql://[REDACTED:DB_CREDENTIALS]@' },
  { name: 'Postgres DSN',          regex: /postgres:\/\/[^@\s]+:[^@\s]+@/gi,                      replacement: 'postgres://[REDACTED:DB_CREDENTIALS]@' },
  { name: 'MongoDB DSN',           regex: /mongodb(\+srv)?:\/\/[^@\s]+:[^@\s]+@/gi,               replacement: 'mongodb://[REDACTED:DB_CREDENTIALS]@' },
  { name: 'DB Password Flag',      regex: /-p(?:assword)?\s+\S+/g,                                replacement: '-p[REDACTED:DB_PASSWORD]' },

  // Private Keys & Certificates — bounded quantifiers to prevent ReDoS
  { name: 'Private Key Block',     regex: /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{1,8000}?-----END [A-Z ]{0,30}PRIVATE KEY-----/g, replacement: '[REDACTED:PRIVATE_KEY_BLOCK]' },
  { name: 'Certificate Block',     regex: /-----BEGIN CERTIFICATE-----[\s\S]{1,8000}?-----END CERTIFICATE-----/g, replacement: '[REDACTED:CERTIFICATE_BLOCK]' },

  // Cloud credentials — specific patterns only
  { name: 'Azure Connection',      regex: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]{1,256}/gi, replacement: '[REDACTED:AZURE_CONNECTION_STRING]' },

  // Environment variable assignments — specific known-dangerous key names only (avoids false positives on getUserPassword(), etc.)
  { name: 'Env Secret Assignment', regex: /(CRYPT_KEY|ENCRYPTION_KEY|HASH_SALT|AUTH_SECRET|APP_SECRET|DB_PASSWORD|DB_PASS|REDIS_PASSWORD|ANTHROPIC_API_KEY|OPENAI_API_KEY|STRIPE_SECRET_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?[^\s"'\n]{4,256}["']?/gi, replacement: '$1=[REDACTED:ENV_SECRET]' },
];

/**
 * Redact sensitive data from a string.
 * Each rule is wrapped in try/catch — a failing rule is skipped, not fatal.
 * Returns partialRedaction: true if any rule failed.
 */
export function redactContent(content) {
  let redacted = content;
  const findings        = [];
  const failedRules     = [];
  let   partialRedaction = false;

  for (const rule of REDACTION_RULES) {
    try {
      if (rule.parser) {
        // Stateful parser path (ReDoS-safe)
        const before  = redacted;
        redacted       = rule.parser(redacted);
        if (redacted !== before) {
          findings.push(`${rule.name} (redacted)`);
        }
      } else {
        // Regex path
        const matches = redacted.match(rule.regex);
        if (matches && matches.length > 0) {
          findings.push(`${rule.name} (${matches.length} instance${matches.length > 1 ? 's' : ''})`);
          redacted = redacted.replace(rule.regex, rule.replacement);
        }
      }
    } catch (err) {
      // Rule failed — skip it, don't block the scan
      failedRules.push({ rule: rule.name, error: err.message });
      partialRedaction = true;
    }
  }

  return { redacted, findings, failedRules, partialRedaction };
}

/**
 * Redact an entire codebase context object.
 * Never throws — always returns something safe to use.
 */
export function redactCodebase(codebaseContext) {
  try {
    const { redacted, findings, failedRules, partialRedaction } = redactContent(codebaseContext.context);
    const totalRedactions = findings.length;

    return {
      context:          { ...codebaseContext, context: redacted },
      summary:          { findings, totalRedactions, failedRules, partialRedaction },
      partialRedaction,
    };
  } catch (err) {
    // Complete redaction failure — return original with warning
    // This should never happen but is a last-resort safety net
    return {
      context:          codebaseContext,
      summary:          { findings: [], totalRedactions: 0, failedRules: [{ rule: 'ALL', error: err.message }], partialRedaction: true },
      partialRedaction: true,
      redactionFailed:  true,
    };
  }
}

/**
 * Display redaction summary — warns if any rules failed
 */
export function showRedactionSummary(summary) {
  if (summary.totalRedactions === 0 && !summary.partialRedaction) {
    console.log(chalk.green('  🛡  No sensitive patterns detected.\n'));
    return;
  }

  if (summary.partialRedaction && summary.failedRules?.length > 0) {
    console.log(chalk.red(`  ⚠  Redaction incomplete — ${summary.failedRules.length} rule(s) failed:`));
    summary.failedRules.forEach(f => {
      console.log(chalk.red(`      • ${f.rule}: ${f.error}`));
    });
    console.log(chalk.yellow('  Review output manually before sharing.\n'));
  }

  if (summary.totalRedactions > 0) {
    console.log(chalk.yellow(`  🛡  Redacted ${summary.totalRedactions} sensitive pattern type${summary.totalRedactions > 1 ? 's' : ''}:`));
    summary.findings.forEach(f => {
      console.log(chalk.gray(`      • ${f}`));
    });
    console.log(chalk.gray('  All redacted values replaced with [REDACTED:TYPE] placeholders.\n'));
  }
}
