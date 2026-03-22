import chalk from 'chalk';

// Patterns to detect and redact sensitive data
const REDACTION_RULES = [
  // API Keys & Tokens
  { name: 'Anthropic API Key',     regex: /sk-ant-[a-zA-Z0-9\-_]{20,}/g,           replacement: '[REDACTED:ANTHROPIC_KEY]' },
  { name: 'AWS Access Key',        regex: /AKIA[0-9A-Z]{16}/g,                      replacement: '[REDACTED:AWS_ACCESS_KEY]' },
  { name: 'AWS Secret Key',        regex: /(?<=["\s])[a-zA-Z0-9/+=]{40}(?=["\s])/g, replacement: '[REDACTED:AWS_SECRET]' },
  { name: 'GitHub Token',          regex: /gh[ps]_[a-zA-Z0-9]{36,}/g,              replacement: '[REDACTED:GITHUB_TOKEN]' },
  { name: 'Generic API Key',       regex: /api[_-]?key\s*[=:]\s*["']?[a-zA-Z0-9\-_]{16,}["']?/gi, replacement: 'api_key=[REDACTED:API_KEY]' },
  { name: 'Generic Secret',        regex: /secret\s*[=:]\s*["']?[a-zA-Z0-9\-_!@#$%^&*]{8,}["']?/gi, replacement: 'secret=[REDACTED:SECRET]' },
  { name: 'Generic Password',      regex: /password\s*[=:]\s*["']?[^\s"']{4,}["']?/gi, replacement: 'password=[REDACTED:PASSWORD]' },
  { name: 'Generic Token',         regex: /token\s*[=:]\s*["']?[a-zA-Z0-9\-_.]{16,}["']?/gi, replacement: 'token=[REDACTED:TOKEN]' },

  // Database connection strings
  { name: 'MySQL DSN',             regex: /mysql:\/\/[^@\s]+:[^@\s]+@/gi,           replacement: 'mysql://[REDACTED:DB_CREDENTIALS]@' },
  { name: 'Postgres DSN',          regex: /postgres:\/\/[^@\s]+:[^@\s]+@/gi,        replacement: 'postgres://[REDACTED:DB_CREDENTIALS]@' },
  { name: 'MongoDB DSN',           regex: /mongodb(\+srv)?:\/\/[^@\s]+:[^@\s]+@/gi, replacement: 'mongodb://[REDACTED:DB_CREDENTIALS]@' },
  { name: 'DB Password Flag',      regex: /-p(?:assword)?\s+\S+/g,                  replacement: '-p[REDACTED:DB_PASSWORD]' },

  // Private Keys & Certificates
  { name: 'Private Key Block',     regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED:PRIVATE_KEY_BLOCK]' },
  { name: 'Certificate Block',     regex: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, replacement: '[REDACTED:CERTIFICATE_BLOCK]' },

  // Cloud & Service credentials
  { name: 'Azure Connection',      regex: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/gi, replacement: '[REDACTED:AZURE_CONNECTION_STRING]' },
  { name: 'Stripe Key',            regex: /sk_(live|test)_[a-zA-Z0-9]{24,}/g,       replacement: '[REDACTED:STRIPE_KEY]' },
  { name: 'Twilio Key',            regex: /SK[a-f0-9]{32}/g,                        replacement: '[REDACTED:TWILIO_KEY]' },
  { name: 'JWT Token',             regex: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g, replacement: '[REDACTED:JWT_TOKEN]' },

  // Environment variable assignments with sensitive values
  { name: 'Env Secret Assignment', regex: /(CRYPT_KEY|ENCRYPTION_KEY|HASH_SALT|AUTH_SECRET|APP_SECRET|DB_PASSWORD|DB_PASS|REDIS_PASSWORD)\s*[=:]\s*["']?[^\s"'\n]{4,}["']?/gi, replacement: '$1=[REDACTED:ENV_SECRET]' },
];

/**
 * Redact sensitive data from a string
 * @param {string} content - raw file content
 * @returns {{ redacted: string, findings: string[] }}
 */
export function redactContent(content) {
  let redacted = content;
  const findings = [];

  for (const rule of REDACTION_RULES) {
    const matches = redacted.match(rule.regex);
    if (matches && matches.length > 0) {
      findings.push(`${rule.name} (${matches.length} instance${matches.length > 1 ? 's' : ''})`);
      redacted = redacted.replace(rule.regex, rule.replacement);
    }
  }

  return { redacted, findings };
}

/**
 * Redact an entire codebase context object
 * @param {object} codebaseContext - { context, fileIndex, ... }
 * @returns {{ context: object, summary: object }}
 */
export function redactCodebase(codebaseContext) {
  const { redacted, findings } = redactContent(codebaseContext.context);
  const totalRedactions = findings.length;

  return {
    context: { ...codebaseContext, context: redacted },
    summary: { findings, totalRedactions }
  };
}

/**
 * Display redaction summary
 */
export function showRedactionSummary(summary) {
  if (summary.totalRedactions === 0) {
    console.log(chalk.green('  🛡  No sensitive patterns detected.\n'));
    return;
  }

  console.log(chalk.yellow(`  🛡  Redacted ${summary.totalRedactions} sensitive pattern type${summary.totalRedactions > 1 ? 's' : ''}:`));
  summary.findings.forEach(f => {
    console.log(chalk.gray(`      • ${f}`));
  });
  console.log(chalk.gray('  All redacted values replaced with [REDACTED:TYPE] placeholders.\n'));
}
