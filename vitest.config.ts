import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'workers/*/src/**/*.test.ts',
      'apps/desktop/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', 'apps/desktop/e2e/**'],
    environment: 'node',
    // Database tests each open their own temp file; isolate so they cannot collide.
    pool: 'forks',
    testTimeout: 20_000,
    reporters: process.env['CI'] === '1' ? ['default', 'json'] : ['default'],
  },
  resolve: {
    alias: {
      '@wr/shared-types': new URL('./packages/shared-types/src/index.ts', import.meta.url)
        .pathname,
      '@wr/document-model': new URL('./packages/document-model/src/index.ts', import.meta.url)
        .pathname,
      '@wr/database': new URL('./packages/database/src/index.ts', import.meta.url).pathname,
      '@wr/zotero-adapter': new URL('./packages/zotero-adapter/src/index.ts', import.meta.url)
        .pathname,
      '@wr/search': new URL('./packages/search/src/index.ts', import.meta.url).pathname,
    },
  },
});
