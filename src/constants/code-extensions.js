// src/constants/code-extensions.js
//
// The single list of file extensions Ghost treats as source code.
//
// Two places need it and they must never disagree:
//
//   src/loader/index.js   decides which files get loaded into the scan context.
//   src/core/verifier.js  strips invented line-number citations like
//                         "Foo.php:42" from narrated reports, because the
//                         narrator fabricates line numbers and cannot be
//                         trusted on them.
//
// The verifier used to carry its own three-entry list (.php, .js, .ts). Every
// other language the loader accepted, and there are twenty-plus, sailed through
// with hallucinated line numbers intact and shipped to the customer. Anything
// added here is scrubbed there automatically.
export const CODE_EXTENSIONS = [
  '.php', '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.java', '.go',
  '.cs', '.cpp', '.c', '.h', '.vue', '.svelte', '.sql', '.xml', '.json',
  '.yaml', '.yml', '.sh', '.bash', '.md',
  // Mobile / native: Swift and Kotlin (incl. Gradle Kotlin scripts).
  '.swift', '.kt', '.kts',
];

// `Foo.php:42`, `Foo.php:42-55`, `Foo.php:42–55` (en dash) -> `Foo.php`
// Built from the list above so a new language cannot be added without also
// being scrubbed. Extensions are escaped and sorted longest-first so `.kts`
// wins over `.kt` and `.jsx` over `.js`.
export function buildLineCitationRegex(extensions = CODE_EXTENSIONS) {
  const alternation = [...extensions]
    .sort((a, b) => b.length - a.length)
    .map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`(${alternation}):\\d+(?:[–-]\\d+)?`, 'gi');
}
