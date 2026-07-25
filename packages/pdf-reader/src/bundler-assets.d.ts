/**
 * Asset-URL imports resolved by the bundler.
 *
 * `import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` is a Vite construct: the
 * suffix tells the bundler to emit the file as an asset and hand back its URL. TypeScript has
 * no idea what `?url` means, so the module has to be declared.
 *
 * Declared here rather than pulled in via `vite/client` types because that would also drop
 * `import.meta.env`, `process.env` shims, and the rest of Vite's ambient surface into a
 * package that must not depend on any of it.
 */
declare module '*?url' {
  const src: string;
  export default src;
}
