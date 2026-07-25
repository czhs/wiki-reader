/**
 * The `rrfile://` protocol.
 *
 * File bytes reach the renderer only through here. The renderer addresses a file by its
 * internal ID; this handler resolves that ID through the database, checks the resulting
 * path against the allowed roots, and streams the bytes. The renderer never receives a
 * filesystem path and therefore cannot construct one.
 *
 * Two separate guarantees are enforced, because either alone is insufficient:
 *   1. the ID must resolve to a row (so arbitrary paths cannot be requested), and
 *   2. that row's path must be inside an allowed root (so a bad row cannot escape either).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve as resolvePath } from 'node:path';
import { Readable } from 'node:stream';
import { protocol, type Session } from 'electron';
import type { Logger } from './logger.js';
import type { AppServices } from './services.js';
import { isInsideRoot, resolveAllowedPath } from './paths.js';

export const PROTOCOL_SCHEME = 'rrfile';

/** Where the built renderer bundle is served from. See `registerAppProtocol`. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Must run before `app.whenReady()`.
 *
 * `rrfile`: `standard` gives the URLs a normal origin so PDF.js range requests behave;
 * `stream: true` enables partial responses so opening a 300 MB PDF does not buffer it all
 * in memory.
 *
 * `app`: the renderer bundle is served from a real origin rather than `file://`. Chromium
 * gives `file://` pages the opaque origin `null`, which blocks ES module scripts (Vite emits
 * `<script type="module" crossorigin>`) and blocks web workers outright — PDF.js needs both.
 * A privileged scheme also means the CSP in `index.html` is enforced against a genuine
 * origin instead of being largely moot.
 */
export function registerProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // Explicitly *not* CORS-enabled and not allowed to bypass CSP: these bytes are
        // untrusted user documents, not application code.
        corsEnabled: false,
        bypassCSP: false,
      },
    },
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // Same-origin module scripts are fetched in CORS mode because of the `crossorigin`
        // attribute Vite emits; same-origin CORS requests need the scheme to allow them.
        corsEnabled: true,
        bypassCSP: false,
      },
    },
  ]);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
};

/**
 * Resolve an `app://` URL to a file inside the bundle directory.
 *
 * Exported for testing. Everything outside `bundleDir` is refused: the renderer must not be
 * able to reach the rest of the filesystem by asking its own origin for `../../`, even
 * though Chromium normalizes most such URLs before they arrive.
 */
export function resolveBundleRequest(
  bundleDir: string,
  url: string,
): { ok: true; path: string; contentType: string } | { ok: false; status: number; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 400, reason: 'malformed app url' };
  }
  if (parsed.protocol !== `${APP_SCHEME}:`) {
    return { ok: false, status: 400, reason: 'wrong scheme' };
  }
  if (parsed.hostname !== APP_HOST) {
    return { ok: false, status: 404, reason: 'unknown app host' };
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { ok: false, status: 400, reason: 'malformed percent-encoding' };
  }
  if (pathname.includes('\0')) return { ok: false, status: 400, reason: 'nul byte in path' };

  const relative = pathname === '' || pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = resolvePath(bundleDir);
  const candidate = resolvePath(join(root, relative));
  if (!isInsideRoot(candidate, root)) {
    return { ok: false, status: 403, reason: 'path escapes the bundle directory' };
  }

  return {
    ok: true,
    path: candidate,
    contentType: CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
  };
}

/** Serve the built renderer bundle from `app://bundle/`. */
export function registerAppProtocol(session: Session, bundleDir: string, logger: Logger): void {
  const log = logger.child('app-protocol');

  session.protocol.handle(APP_SCHEME, async (request: Request): Promise<Response> => {
    const resolved = resolveBundleRequest(bundleDir, request.url);
    if (!resolved.ok) {
      log.warn('bundle request refused', { status: resolved.status, reason: resolved.reason });
      return new Response(null, { status: resolved.status, statusText: resolved.reason });
    }

    try {
      const stats = await stat(resolved.path);
      if (!stats.isFile()) return new Response(null, { status: 404, statusText: 'not a file' });
    } catch {
      return new Response(null, { status: 404, statusText: 'not found' });
    }

    const stream = Readable.toWeb(createReadStream(resolved.path)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': resolved.contentType },
    });
  });

  log.info('app protocol registered', { bundleDir });
}

/** `rrfile://dfl_0123.../` -> `dfl_0123...`. Rejects anything with path segments. */
export function parseFileId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) return null;

  // For a `standard` scheme the id lands in the host. A non-empty path would mean the
  // renderer tried to address something *within* the file — refuse rather than interpret.
  const id = decodeURIComponent(parsed.hostname);
  const path = parsed.pathname.replace(/^\/+/, '');
  if (path.length > 0) return null;
  if (!/^dfl_[0-9a-hjkmnp-tv-z]{26}$/.test(id)) return null;
  return id;
}

const MIME_FALLBACK = 'application/octet-stream';

/**
 * Resolve a request to a response. Exported separately from registration so the resolution
 * rules — including every refusal path — are testable without an Electron session.
 */
export async function resolveFileRequest(
  services: AppServices,
  url: string,
): Promise<
  | { ok: true; path: string; mimeType: string; byteSize: number }
  | { ok: false; status: number; reason: string }
> {
  const fileId = parseFileId(url);
  if (fileId === null) return { ok: false, status: 400, reason: 'malformed rrfile url' };

  const file = services.db.files.getById(fileId);
  if (file === null) return { ok: false, status: 404, reason: 'unknown file id' };

  // The *real* path, not the stored one: a symlink inside an allowed root would otherwise
  // pass the lexical check and then be followed by `stat` and `createReadStream` below.
  const resolved = await resolveAllowedPath(file.path, services.allowed);
  if (!resolved.ok) {
    if (resolved.reason === 'outside-roots') {
      services.logger.warn('refused file outside allowed roots', { fileId });
      return { ok: false, status: 403, reason: 'path outside allowed roots' };
    }
    return { ok: false, status: 404, reason: 'file missing on disk' };
  }
  const realPath = resolved.path;

  try {
    const stats = await stat(realPath);
    if (!stats.isFile()) return { ok: false, status: 404, reason: 'not a regular file' };
    return {
      ok: true,
      path: realPath,
      mimeType: file.mimeType === '' ? MIME_FALLBACK : file.mimeType,
      byteSize: stats.size,
    };
  } catch {
    return { ok: false, status: 404, reason: 'file missing on disk' };
  }
}

/** Install the handler on a session. Called once the app is ready. */
export function registerFileProtocol(services: AppServices, session: Session): void {
  const logger = services.logger.child('rrfile');

  session.protocol.handle(PROTOCOL_SCHEME, async (request: Request): Promise<Response> => {
    const resolved = await resolveFileRequest(services, request.url);
    if (!resolved.ok) {
      logger.warn('file request refused', { status: resolved.status, reason: resolved.reason });
      return new Response(null, { status: resolved.status, statusText: resolved.reason });
    }

    const range = request.headers.get('range');
    if (range === null) {
      const stream = Readable.toWeb(createReadStream(resolved.path)) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': resolved.mimeType,
          'content-length': String(resolved.byteSize),
          'accept-ranges': 'bytes',
        },
      });
    }

    // PDF.js asks for byte ranges so it can render page 200 without reading pages 1..199.
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match === null) {
      return new Response(null, { status: 416, statusText: 'malformed range' });
    }
    const [, rawStart = '', rawEnd = ''] = match;
    const start = rawStart === '' ? 0 : Number.parseInt(rawStart, 10);
    const end = rawEnd === '' ? resolved.byteSize - 1 : Number.parseInt(rawEnd, 10);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= resolved.byteSize) {
      return new Response(null, { status: 416, statusText: 'unsatisfiable range' });
    }
    const clampedEnd = Math.min(end, resolved.byteSize - 1);

    const stream = Readable.toWeb(
      createReadStream(resolved.path, { start, end: clampedEnd }),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 206,
      headers: {
        'content-type': resolved.mimeType,
        'content-length': String(clampedEnd - start + 1),
        'content-range': `bytes ${String(start)}-${String(clampedEnd)}/${String(resolved.byteSize)}`,
        'accept-ranges': 'bytes',
      },
    });
  });

  logger.info('rrfile protocol registered', { roots: services.allowed.roots.length });
}


/** Refuse every navigation away from the app's own origins (defence in depth). */
export function lockDownNavigation(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      // Milestone 1 reads local documents only; nothing legitimately reaches the network from
      // a renderer, so remote loads are blocked rather than merely discouraged by CSP. The
      // dev server — and its HMR socket — are the sole exception.
      callback({ cancel: !isLoopbackUrl(details.url) });
    },
  );
}

/**
 * True only for the local dev server's own origins.
 *
 * A `startsWith('http://localhost')` test admits `http://localhost.attacker.example/`, which
 * is an entirely different host that merely begins with those characters — the same
 * prefix-collision bug `isInsideRoot` exists to avoid for paths. Comparing the parsed
 * hostname is what makes the check mean what it says.
 */
export function isLoopbackUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!['http:', 'ws:'].includes(url.protocol)) return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
