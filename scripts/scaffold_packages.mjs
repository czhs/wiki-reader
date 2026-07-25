#!/usr/bin/env node
/**
 * Generates package.json + tsconfig.json for every workspace library package.
 * Idempotent: rewrites the generated files, leaves src/ untouched.
 * Run: node scripts/scaffold_packages.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const REACT = { react: '^18.3.1' };
const REACT_DEV = {
  '@types/react': '^18.3.18',
  '@types/react-dom': '^18.3.5',
  '@vitejs/plugin-react': '^4.3.4',
};

/** @type {Array<{dir:string,name:string,deps?:Record<string,string>,devDeps?:Record<string,string>,refs?:string[],dom?:boolean}>} */
const PACKAGES = [
  {
    dir: 'packages/shared-types',
    name: '@wr/shared-types',
    deps: { zod: '^3.24.1' },
    refs: [],
  },
  {
    dir: 'packages/document-model',
    name: '@wr/document-model',
    deps: { zod: '^3.24.1', '@wr/shared-types': 'workspace:*' },
    refs: ['packages/shared-types'],
  },
  {
    dir: 'packages/database',
    name: '@wr/database',
    deps: {
      'better-sqlite3': '^11.8.1',
      zod: '^3.24.1',
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
    },
    devDeps: { '@types/better-sqlite3': '^7.6.12' },
    refs: ['packages/shared-types', 'packages/document-model'],
  },
  {
    dir: 'packages/zotero-adapter',
    name: '@wr/zotero-adapter',
    deps: {
      zod: '^3.24.1',
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
    },
    refs: ['packages/shared-types', 'packages/document-model'],
  },
  {
    dir: 'packages/search',
    name: '@wr/search',
    deps: {
      'better-sqlite3': '^11.8.1',
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
      '@wr/database': 'workspace:*',
    },
    devDeps: { '@types/better-sqlite3': '^7.6.12' },
    refs: ['packages/shared-types', 'packages/document-model', 'packages/database'],
  },
  {
    dir: 'packages/shared-ui',
    name: '@wr/shared-ui',
    deps: { ...REACT },
    devDeps: { ...REACT_DEV },
    refs: [],
    dom: true,
  },
  {
    dir: 'packages/workbench',
    name: '@wr/workbench',
    deps: {
      ...REACT,
      'react-dom': '^18.3.1',
      dockview: '^3.0.0',
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
      '@wr/shared-ui': 'workspace:*',
    },
    devDeps: { ...REACT_DEV },
    refs: ['packages/shared-types', 'packages/document-model', 'packages/shared-ui'],
    dom: true,
  },
  {
    dir: 'packages/pdf-reader',
    name: '@wr/pdf-reader',
    deps: {
      ...REACT,
      'pdfjs-dist': '^4.10.38',
      'react-pdf-highlighter-extended': '^8.1.0',
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
      '@wr/workbench': 'workspace:*',
    },
    devDeps: { ...REACT_DEV },
    refs: ['packages/shared-types', 'packages/document-model', 'packages/workbench'],
    dom: true,
  },
  {
    dir: 'packages/html-reader',
    name: '@wr/html-reader',
    deps: {
      ...REACT,
      '@mozilla/readability': '^0.5.0',
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
      '@wr/workbench': 'workspace:*',
    },
    devDeps: { ...REACT_DEV, jsdom: '^25.0.1', '@types/jsdom': '^21.1.7' },
    refs: ['packages/shared-types', 'packages/document-model', 'packages/workbench'],
    dom: true,
  },
  {
    dir: 'packages/annotations',
    name: '@wr/annotations',
    deps: {
      ...REACT,
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
      '@wr/workbench': 'workspace:*',
      '@wr/shared-ui': 'workspace:*',
    },
    devDeps: { ...REACT_DEV },
    refs: [
      'packages/shared-types',
      'packages/document-model',
      'packages/workbench',
      'packages/shared-ui',
    ],
    dom: true,
  },
  {
    dir: 'packages/note-editor',
    name: '@wr/note-editor',
    deps: {
      ...REACT,
      '@tiptap/core': '^2.11.2',
      '@tiptap/react': '^2.11.2',
      '@tiptap/starter-kit': '^2.11.2',
      '@tiptap/pm': '^2.11.2',
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
      '@wr/workbench': 'workspace:*',
    },
    devDeps: { ...REACT_DEV },
    refs: ['packages/shared-types', 'packages/document-model', 'packages/workbench'],
    dom: true,
  },
  {
    dir: 'workers/text-extraction',
    name: '@wr/text-extraction-worker',
    deps: {
      'pdfjs-dist': '^4.10.38',
      '@wr/shared-types': 'workspace:*',
      '@wr/document-model': 'workspace:*',
    },
    refs: ['packages/shared-types', 'packages/document-model'],
  },
  {
    dir: 'workers/indexing',
    name: '@wr/indexing-worker',
    deps: {
      '@wr/shared-types': 'workspace:*',
      '@wr/database': 'workspace:*',
      '@wr/search': 'workspace:*',
    },
    refs: ['packages/shared-types', 'packages/database', 'packages/search'],
  },
];

for (const pkg of PACKAGES) {
  const abs = join(ROOT, pkg.dir);
  mkdirSync(join(abs, 'src'), { recursive: true });

  const packageJson = {
    name: pkg.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
    scripts: {
      build: 'tsc -b',
      clean: 'rm -rf dist *.tsbuildinfo',
    },
    ...(pkg.deps ? { dependencies: pkg.deps } : {}),
    ...(pkg.devDeps ? { devDependencies: pkg.devDeps } : {}),
  };
  writeFileSync(
    join(abs, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n',
    'utf8',
  );

  const tsconfig = {
    extends: relative(abs, join(ROOT, 'tsconfig.base.json')),
    compilerOptions: {
      outDir: './dist',
      rootDir: './src',
      tsBuildInfoFile: './dist/.tsbuildinfo',
      ...(pkg.dom
        ? { lib: ['ES2023', 'DOM', 'DOM.Iterable'], jsx: 'react-jsx' }
        : {}),
    },
    include: ['src/**/*'],
    exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'dist'],
    ...(pkg.refs && pkg.refs.length
      ? { references: pkg.refs.map((r) => ({ path: relative(abs, join(ROOT, r)) })) }
      : {}),
  };
  writeFileSync(
    join(abs, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2) + '\n',
    'utf8',
  );

  console.log(`scaffolded ${pkg.name}`);
}

// Root solution tsconfig for `pnpm typecheck`.
const buildConfig = {
  files: [],
  references: [
    ...PACKAGES.map((p) => ({ path: `./${p.dir}` })),
    { path: './apps/desktop' },
  ],
};
writeFileSync(
  join(ROOT, 'tsconfig.build.json'),
  JSON.stringify(buildConfig, null, 2) + '\n',
  'utf8',
);
console.log('wrote tsconfig.build.json');
