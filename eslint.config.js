import globals from 'globals'

// ESLint flat config for VisionPower.
//
// Why this exists: the project once shipped `homedir is not defined` because a
// used-but-unimported symbol slipped past `node --check` (syntax only) and the
// unit tests (the default-path branch was short-circuited by an always-injected
// env var). The `no-undef` rule here is the static guard that catches exactly
// that class of bug. Run with `npm run lint`.
export default [
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The hard gate: any identifier that is neither imported, declared, nor a
      // known global is an error. This is what would have caught the bug.
      'no-undef': 'error',
      // Soft signal for dead code; surfaced but never blocks lint.
      'no-unused-vars': 'warn',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'package-lock.json',
      'VisionPower-Skill/**',
    ],
  },
]
