import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * Flat ESLint config.
 *
 * The rules that matter most here are the import boundaries: renderer packages must not be
 * able to reach Electron, the database, or the Zotero adapter. `scripts/verify_completion.py`
 * enforces the same boundary independently, so a disabled rule cannot hide a violation.
 */

const RENDERER_FORBIDDEN = [
  { name: 'electron', message: 'Renderer packages must not import electron. Use the preload bridge.' },
  { name: 'better-sqlite3', message: 'Renderer packages must not touch the database.' },
  { name: '@wr/database', message: 'Renderer packages must not import @wr/database. Go through IPC.' },
  { name: '@wr/zotero-adapter', message: 'Renderer packages must not import @wr/zotero-adapter. Go through IPC.' },
  { name: 'fs', message: 'No filesystem access in renderer packages.' },
  { name: 'node:fs', message: 'No filesystem access in renderer packages.' },
  { name: 'child_process', message: 'No process spawning in renderer packages.' },
  { name: 'node:child_process', message: 'No process spawning in renderer packages.' },
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/resources/native/**',
      '**/test/fixtures/**',
      'logs/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        globalThis: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-undef': 'off', // TypeScript already checks this, and knows about DOM/Node libs.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // Renderer-side packages: enforce the process boundary.
    files: [
      'packages/workbench/**/*.ts',
      'packages/workbench/**/*.tsx',
      'packages/pdf-reader/**/*.ts',
      'packages/pdf-reader/**/*.tsx',
      'packages/html-reader/**/*.ts',
      'packages/html-reader/**/*.tsx',
      'packages/annotations/**/*.ts',
      'packages/annotations/**/*.tsx',
      'packages/note-editor/**/*.ts',
      'packages/note-editor/**/*.tsx',
      'packages/shared-ui/**/*.ts',
      'packages/shared-ui/**/*.tsx',
      'apps/desktop/src/renderer/**/*.ts',
      'apps/desktop/src/renderer/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: RENDERER_FORBIDDEN }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'apps/desktop/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Build scripts run under plain Node, outside the TypeScript program.
    files: ['scripts/**/*.mjs', '*.config.js', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        globalThis: 'readonly',
        URL: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];
