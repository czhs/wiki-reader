#!/usr/bin/env node
/**
 * Builds better-sqlite3 against the Electron ABI and stages the result in a location
 * separate from the Node-ABI build.
 *
 * Why this exists
 * ---------------
 * better-sqlite3 loads `build/Release/better_sqlite3.node` — a single path with no ABI
 * component. Node (vitest) and Electron use different ABIs, so a rebuild for one silently
 * breaks the other. Rather than rebuilding back and forth, we:
 *
 *   1. Preserve the Node-ABI artifact.
 *   2. Rebuild for Electron.
 *   3. Copy the Electron artifact to apps/desktop/resources/native/<abi>/.
 *   4. Restore the Node-ABI artifact so `pnpm test` keeps working.
 *
 * The main process then opens the database with
 * `new Database(path, { nativeBinding: <staged Electron artifact> })`.
 *
 * Run: node scripts/build_electron_native.mjs
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// With pnpm's isolated linker these are not root dependencies, so resolve each from the
// workspace package that actually declares it.
const fromDatabase = createRequire(join(ROOT, 'packages', 'database', 'package.json'));
const fromDesktop = createRequire(join(ROOT, 'apps', 'desktop', 'package.json'));


const MODULE_DIR = dirname(fromDatabase.resolve('better-sqlite3/package.json'));
const BUILT = join(MODULE_DIR, 'build', 'Release', 'better_sqlite3.node');
const NODE_BACKUP = `${BUILT}.node-abi`;

const electronVersion = JSON.parse(
  readFileSync(fromDesktop.resolve('electron/package.json'), 'utf8'),
).version;

const STAGE_DIR = join(ROOT, 'apps', 'desktop', 'resources', 'native', `electron-${electronVersion}`);
const STAGED = join(STAGE_DIR, 'better_sqlite3.node');

if (existsSync(STAGED)) {
  console.log(`electron-abi binding already staged: ${STAGED}`);
  process.exit(0);
}

if (!existsSync(BUILT)) {
  console.error(
    `error: ${BUILT} not found.\nRun \`pnpm -r rebuild\` first so the Node-ABI build exists.`,
  );
  process.exit(1);
}

console.log(`preserving node-abi binding -> ${NODE_BACKUP}`);
copyFileSync(BUILT, NODE_BACKUP);

let failure = null;
try {
  console.log(`rebuilding better-sqlite3 for electron ${electronVersion}...`);
  execFileSync(
    join(ROOT, 'node_modules', '.bin', 'electron-rebuild'),
    [
      '--version',
      electronVersion,
      '--only',
      'better-sqlite3',
      '--module-dir',
      MODULE_DIR,
      '--force',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );

  mkdirSync(STAGE_DIR, { recursive: true });
  copyFileSync(BUILT, STAGED);
  console.log(`staged electron-abi binding -> ${STAGED}`);
} catch (error) {
  failure = error;
} finally {
  // Always restore the Node-ABI build so the test suite keeps working.
  if (existsSync(NODE_BACKUP)) {
    renameSync(NODE_BACKUP, BUILT);
    console.log('restored node-abi binding');
  }
  rmSync(join(MODULE_DIR, 'build', 'Release', 'obj.target'), {
    recursive: true,
    force: true,
  });
}

if (failure) {
  console.error('electron rebuild failed:', failure.message);
  process.exit(1);
}
