// Conventional Commits v1.0.0 validator for the lefthook commit-msg stage.
// https://www.conventionalcommits.org/en/v1.0.0/
//
// Accepts:  <type>[optional scope][!]: <description>
//   type   = feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert
//   scope  = optional, in parens, e.g. feat(server):
//   !      = optional, marks a breaking change
// Also accepts merge/revert/fixup commits and ignores comment lines.
//
// Usage (lefthook): node scripts/check-commit-msg.ts {1}  (path to commit msg file)

import { readFileSync } from 'node:fs';

const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

const msgPath = process.argv[2];
if (!msgPath) {
  console.error('check-commit-msg: no commit message file path given');
  process.exit(2);
}

const raw = readFileSync(msgPath, 'utf8');
// First non-empty, non-comment line is the header (subject).
const header =
  raw
    .split('\n')
    .find((l) => l.trim() && !l.startsWith('#'))
    ?.trim() ?? '';

// Allow merge/revert/fixup/squash auto-generated headers.
if (/^(Merge |Revert "|fixup! |squash! )/.test(header)) {
  process.exit(0);
}

const typeAlt = TYPES.join('|');
// <type>(scope)!: description  — scope and ! optional, single space after colon.
const pattern = new RegExp(`^(${typeAlt})(\\([a-z0-9][a-z0-9._-]*\\))?(!)?: .+`);

if (pattern.test(header)) {
  // Optional: warn (don't fail) if subject is very long.
  if (header.length > 100) {
    console.warn(`commit-msg: header is ${header.length} chars (>100); consider shortening.`);
  }
  process.exit(0);
}

console.error(`
✗ Commit message does not follow Conventional Commits v1.0.0.

  got:      ${header || '(empty)'}
  expected: <type>[(scope)][!]: <description>
  types:    ${TYPES.join(', ')}

  examples:
    feat: add /reload slash command
    fix(server): reject cross-origin websocket upgrades
    docs: document --recursive clone for the vendored submodule
    refactor(web)!: drop the legacy event bus

  see https://www.conventionalcommits.org/en/v1.0.0/
`);
process.exit(1);
