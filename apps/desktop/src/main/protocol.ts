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
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
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

export interface ParsedFileRequest {
  readonly fileId: string;
  /**
   * A resource *within* the addressed file's snapshot, or `''` for the file itself.
   *
   * Only an archived page has these: a saved article references its own images and CSS by
   * relative path, and those requests arrive at this origin because the page is served from
   * it. Everything else addresses one file and nothing inside it.
   */
  readonly resourcePath: string;
}

/**
 * `rrfile://dfl_0123.../` -> that file; `rrfile://dfl_0123.../img/hero.png` -> a resource
 * beside it inside the same snapshot.
 *
 * Parsing stops at the shape. Whether a resource path is *allowed* — whether the base file is
 * a snapshot at all, and whether the target stays inside it — is decided in
 * `resolveFileRequest`, where the database row and the real path are available.
 */
export function parseFileRequest(url: string): ParsedFileRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) return null;

  // For a `standard` scheme the id lands in the host.
  const fileId = decodeURIComponent(parsed.hostname);
  if (!/^dfl_[0-9a-hjkmnp-tv-z]{26}$/.test(fileId)) return null;

  let resourcePath: string;
  try {
    resourcePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch {
    // A malformed percent-escape is refused rather than passed through half-decoded.
    return null;
  }
  // A NUL truncates the path at the syscall boundary, so a name containing one would be
  // checked as one string and opened as a shorter one.
  if (resourcePath.includes('\0')) return null;
  return { fileId, resourcePath };
}

/** `rrfile://dfl_0123.../` -> `dfl_0123...`. Null when the URL addresses a resource within. */
export function parseFileId(url: string): string | null {
  const parsed = parseFileRequest(url);
  if (parsed === null || parsed.resourcePath.length > 0) return null;
  return parsed.fileId;
}

const MIME_FALLBACK = 'application/octet-stream';

/**
 * What resolving a file request actually needs. Narrower than `AppServices` so the rules can
 * be exercised against a database and a set of roots, with no Zotero client or search index
 * standing by to satisfy a type. `AppServices` satisfies it structurally.
 */
export type FileRequestServices = Pick<AppServices, 'db' | 'allowed' | 'logger'>;

/**
 * Resolve a request to a response. Exported separately from registration so the resolution
 * rules — including every refusal path — are testable without an Electron session.
 */
export async function resolveFileRequest(
  services: FileRequestServices,
  url: string,
): Promise<
  | { ok: true; path: string; mimeType: string; byteSize: number }
  | { ok: false; status: number; reason: string }
> {
  const request = parseFileRequest(url);
  if (request === null) return { ok: false, status: 400, reason: 'malformed rrfile url' };
  const { fileId, resourcePath } = request;

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

  const target =
    resourcePath === ''
      ? { path: resolved.path, mimeType: file.mimeType === '' ? MIME_FALLBACK : file.mimeType }
      : snapshotResource(resolved.path, file.mimeType, resourcePath);
  if ('status' in target) {
    services.logger.warn('refused snapshot resource', { fileId, reason: target.reason });
    return { ok: false, status: target.status, reason: target.reason };
  }

  // A resource path is resolved twice on purpose: once lexically against the snapshot
  // directory above, and again here through the allowed roots, so a symlink *inside* the
  // snapshot cannot hand out a file from outside it.
  const realTarget = await resolveAllowedPath(target.path, services.allowed);
  if (!realTarget.ok) {
    if (realTarget.reason === 'outside-roots') {
      return { ok: false, status: 403, reason: 'path outside allowed roots' };
    }
    return { ok: false, status: 404, reason: 'file missing on disk' };
  }
  if (resourcePath !== '' && !isInsideRoot(realTarget.path, snapshotRootFor(resolved.path))) {
    return { ok: false, status: 403, reason: 'resource outside its snapshot' };
  }

  try {
    const stats = await stat(realTarget.path);
    if (!stats.isFile()) return { ok: false, status: 404, reason: 'not a regular file' };
    return {
      ok: true,
      path: realTarget.path,
      mimeType: target.mimeType,
      byteSize: stats.size,
    };
  } catch {
    return { ok: false, status: 404, reason: 'file missing on disk' };
  }
}

/** The directory a snapshot owns: the one holding its entry page. */
function snapshotRootFor(entryPath: string): string {
  return dirname(entryPath);
}

/**
 * Resolve a resource referenced by an archived page, against that page's own directory.
 *
 * Two refusals matter here, and they are separate. Only an *archived page* has resources at
 * all, so a PDF row cannot be used as a handle on the directory it happens to sit in — that
 * would turn every Zotero attachment into a directory listing. And the resolved target must
 * stay inside the snapshot: hostile archived HTML asking for `../../other-item/notes.pdf` is
 * asking for a document it was never given, and the allowed-roots check alone would permit it
 * because the whole library is an allowed root.
 */
function snapshotResource(
  entryPath: string,
  entryMimeType: string,
  resourcePath: string,
): { path: string; mimeType: string } | { status: number; reason: string } {
  if (!/^text\/html\b/i.test(entryMimeType)) {
    return { status: 403, reason: 'only an archived page has resources' };
  }
  const root = snapshotRootFor(entryPath);
  const candidate = resolvePath(root, resourcePath);
  if (!isInsideRoot(candidate, root)) {
    return { status: 403, reason: 'resource outside its snapshot' };
  }
  return {
    path: candidate,
    mimeType: CONTENT_TYPES[extname(candidate).toLowerCase()] ?? MIME_FALLBACK,
  };
}

/**
 * The headers served with a snapshot's bytes.
 *
 * The reader frames an archived page from this origin, so this is the last place a policy can
 * be attached to it — and the only place that cannot be overridden by the markup, which came
 * from the open web and may carry a `<meta http-equiv>` policy of its own. The two combine as
 * the intersection, so a permissive one in the page cannot widen this one.
 *
 * `default-src 'none'` denies everything not named below; scripts, frames, workers and
 * `connect-src` are therefore all refused without needing to be listed.
 *
 * The allowances are the scheme, not `'self'`: the frame is sandboxed without
 * `allow-same-origin`, so its origin is opaque and `'self'` would match nothing at all —
 * including its own stylesheet. What keeps `rrfile:` from meaning "any document in the
 * library" is `resolveFileRequest`, which bounds a resource to its own snapshot.
 *
 * `'unsafe-inline'` for styles is not a concession, it is the point: pages save their layout
 * as `<style>` blocks and `style=` attributes, and a saved page rendered without them is not
 * the page. With scripts denied and every remote origin denied, inline CSS has nowhere to
 * send anything.
 */
export function snapshotSecurityHeaders(mimeType: string): Readonly<Record<string, string>> {
  if (!/^text\/html\b/i.test(mimeType)) return {};
  return {
    'content-security-policy': [
      "default-src 'none'",
      "img-src rrfile: data:",
      "style-src rrfile: 'unsafe-inline'",
      "font-src rrfile: data:",
      'media-src rrfile:',
      "form-action 'none'",
      "base-uri 'none'",
      // Belt to the iframe's braces: the sandbox is re-declared by the response itself, so a
      // future caller that frames a snapshot without the attribute still gets it.
      'sandbox',
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
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

    const security = snapshotSecurityHeaders(resolved.mimeType);

    const range = request.headers.get('range');
    if (range === null) {
      const stream = Readable.toWeb(createReadStream(resolved.path)) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': resolved.mimeType,
          'content-length': String(resolved.byteSize),
          'accept-ranges': 'bytes',
          ...security,
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
        ...security,
      },
    });
  });

  logger.info('rrfile protocol registered', { roots: services.allowed.roots.length });
}


/**
 * Deny every capability the renderer could ask for, and every remote request it could make.
 *
 * (The name is narrower than the job: navigation itself is refused by `will-navigate` in
 * `index.ts`. This is the session-level half.)
 */
export function lockDownNavigation(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  // Chromium routes some capability queries through a *synchronous* check that never reaches
  // the request handler above. Without this, those fall back to Chromium's default policy
  // rather than the deny-all the app intends — the two handlers are not alternatives.
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      callback({ cancel: blocksRemoteRequest(details.url) });
    },
  );
}

/**
 * Whether a request intercepted by the filter above is cancelled.
 *
 * Nothing legitimately reaches the network from a renderer, so remote loads are blocked rather
 * than merely discouraged by CSP. The dev server — and its HMR socket — are the sole exception.
 *
 * This is what stops an archived page phoning home. A saved article keeps the markup of the
 * site it came from, tracking pixels and analytics scripts included; served from `rrfile://`
 * those become live requests to third parties, announcing what the user is reading. The
 * snapshot's *own* images and CSS come back through `rrfile://` and are never intercepted here.
 */
export function blocksRemoteRequest(url: string): boolean {
  return !isLoopbackUrl(url);
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
