import { createReadStream, cpSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
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
 *
 * Dev is served rather than copied, and it is not optional: `pnpm dev` is where someone looks
 * to confirm a PDF renders correctly, and a build-only plugin would 404 both directories
 * there and show exactly the substituted fonts they were checking had gone away.
 */
const PDFJS_ASSET_DIRS = ['standard_fonts', 'cmaps'] as const;

function pdfjsAssetRoot(): string {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  for (const asset of PDFJS_ASSET_DIRS) {
    if (!existsSync(resolve(root, asset))) {
      throw new Error(`pdfjs-dist is missing ${asset}/; the reader would substitute fonts`);
    }
  }
  return root;
}

function pdfjsAssets(): Plugin {
  return {
    name: 'wr-pdfjs-assets',

    // Production: land both directories inside the bundle the `app://` handler serves.
    closeBundle() {
      const root = pdfjsAssetRoot();
      const outDir = resolve(import.meta.dirname, 'out/renderer');
      for (const asset of PDFJS_ASSET_DIRS) {
        cpSync(resolve(root, asset), resolve(outDir, asset), { recursive: true });
      }
    },

    // Dev: serve them from node_modules at the same paths, so `new URL('standard_fonts/',
    // document.baseURI)` resolves identically under the dev server and under `app://`.
    configureServer(server) {
      const root = pdfjsAssetRoot();
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0] ?? '';
        const asset = PDFJS_ASSET_DIRS.find((dir) => path.startsWith(`/${dir}/`));
        if (asset === undefined) return next();

        // Resolved and re-checked rather than concatenated: `..` in the request must not
        // reach outside the asset directory, dev server or not.
        const directory = resolve(root, asset);
        const file = normalize(join(directory, decodeURIComponent(path.slice(asset.length + 2))));
        if (!file.startsWith(directory + '/') || !existsSync(file) || !statSync(file).isFile()) {
          return next();
        }
        response.setHeader('content-type', 'application/octet-stream');
        createReadStream(file).pipe(response);
        return undefined;
      });
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
