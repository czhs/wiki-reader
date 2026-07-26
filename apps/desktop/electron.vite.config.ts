import { cpSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Emit PDF.js's font and character-map data beside the renderer bundle.
 *
 * PDF.js does not embed either. Without `standard_fonts/` it cannot draw the 14 standard
 * fonts a PDF is allowed to reference without embedding, and substitutes something with
 * different metrics — 25 of the 71 papers in a real Zotero library render that way, which is
 * a document that is *not* in its original form. Without `cmaps/` a CID-keyed font (most CJK
 * documents) maps to the wrong glyphs entirely.
 *
 * They are copied rather than imported because PDF.js fetches them by URL at runtime, one
 * file per font actually used. `app://bundle/` serves anything under the bundle directory,
 * so landing them here makes them same-origin and reachable under the renderer's CSP.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: 'wr-pdfjs-assets',
    apply: 'build',
    closeBundle() {
      const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
      const outDir = resolve(import.meta.dirname, 'out/renderer');
      for (const asset of ['standard_fonts', 'cmaps']) {
        const from = resolve(pdfjsRoot, asset);
        if (!existsSync(from)) {
          throw new Error(`pdfjs-dist is missing ${asset}/; the reader would substitute fonts`);
        }
        cpSync(from, resolve(outDir, asset), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/main/index.ts'),
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        // The sandboxed renderer can only load a CommonJS preload.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), pdfjsAssets()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/renderer/index.html'),
      },
    },
  },
});
