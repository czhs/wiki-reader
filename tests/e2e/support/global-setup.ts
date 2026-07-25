/**
 * Build the application before any spec runs.
 *
 * The E2E suite must exercise the *built* main, preload and renderer bundles — that is the
 * only configuration in which the security invariants (sandboxed renderer, CommonJS preload,
 * `app://` origin) are the ones the shipped app uses. Building here rather than in a package
 * script means `pnpm test:e2e` is self-sufficient, which is how the verifier invokes it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export default function globalSetup(): void {
  execFileSync('pnpm', ['build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  const mainBundle = join(REPO_ROOT, 'apps', 'desktop', 'out', 'main', 'index.js');
  if (!existsSync(mainBundle)) {
    throw new Error(`e2e: build did not produce ${mainBundle}`);
  }
}
