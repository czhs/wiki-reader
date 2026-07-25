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
import { Readable } from 'node:stream';
import { protocol, type Session } from 'electron';
import type { AppServices } from './services.js';
import { isAllowedPath } from './paths.js';

export const PROTOCOL_SCHEME = 'rrfile';

/**
 * Must run before `app.whenReady()`.
 *
 * `standard` gives the URLs a normal origin so PDF.js range requests behave; `stream: true`
 * enables partial responses so opening a 300 MB PDF does not buffer it all in memory.
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
  ]);
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

  if (!isAllowedPath(file.path, services.allowed)) {
    services.logger.warn('refused file outside allowed roots', { fileId });
    return { ok: false, status: 403, reason: 'path outside allowed roots' };
  }

  try {
    const stats = await stat(file.path);
    if (!stats.isFile()) return { ok: false, status: 404, reason: 'not a regular file' };
    return {
      ok: true,
      path: file.path,
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
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    // Milestone 1 reads local documents only; nothing legitimately reaches the network from
    // a renderer, so remote loads are blocked rather than merely discouraged by CSP.
    callback({ cancel: !details.url.startsWith('http://localhost') });
  });
}
