/**
 * `rrfile://` as a saved web page needs it.
 *
 * A PDF is one file, so until now the protocol addressed exactly one file per request and
 * refused any path within it. An archived page is not one file: it is an entry document plus
 * the images, stylesheets and fonts it references by relative path, and the browser resolves
 * those against the page's own origin. So `rrfile://<file-id>/assets/style.css` has to work.
 *
 * That widening is the whole risk here, and it is why every refusal below is tested next to the
 * thing it permits. Archived HTML is hostile input: the markup came from the open web and gets
 * to choose the URLs. Three separate boundaries hold:
 *
 *   1. only an archived page has resources at all, so a PDF row cannot be turned into a handle
 *      on the directory it happens to share with other people's documents;
 *   2. a resource must resolve inside its own snapshot, lexically *and* after symlinks, because
 *      the allowed roots contain the entire library and would happily serve a sibling item;
 *   3. anything the page tries to fetch from the network is cancelled outright.
 *
 * The database and the files are real; only Electron's session is absent, which is why
 * `resolveFileRequest` is exported separately from the handler that installs it.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WikiReaderDatabase } from '@wr/database';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';
import { allowedRoots } from '../../apps/desktop/src/main/paths.js';
import {
  blocksRemoteRequest,
  parseFileId,
  parseFileRequest,
  resolveFileRequest,
  type FileRequestServices,
} from '../../apps/desktop/src/main/protocol.js';

const PAGE_HTML = [
  '<!doctype html>',
  '<meta charset="utf-8">',
  '<title>Why Sleep Matters</title>',
  '<link rel="stylesheet" href="assets/style.css">',
  '<h1>Why Sleep Matters</h1>',
  '<img src="assets/img/figure-1.png" alt="Sleep stages">',
  '',
].join('\n');

const STYLE_CSS = 'h1 { font-family: Georgia, serif; }\n';
/** A one-pixel PNG, written as bytes so the served type is checked against real content. */
const FIGURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let dir: string;
let libraryRoot: string;
/** The directory the snapshot owns. Everything it may load lives under here. */
let snapshotDir: string;
/** A sibling item in the same library: inside the allowed roots, outside the snapshot. */
let siblingDir: string;
/** Outside the allowed roots entirely. */
let elsewhere: string;
let db: WikiReaderDatabase;
let services: FileRequestServices;

function hashOf(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Seed a document whose primary file is `path`, and return the id the renderer would use. */
function seedFile(path: string, mimeType: string, docType: 'webpage' | 'pdf'): string {
  const document = db.documents.create({ title: path, docType, source: 'zotero' });
  const { file } = db.files.upsertByPath({
    documentId: document.id,
    path,
    mimeType,
    byteSize: statSync(path).size,
    contentHash: hashOf(path),
    role: docType === 'webpage' ? 'snapshot' : 'primary',
  });
  return file.id;
}

let pageFileId: string;
let pdfFileId: string;

beforeEach(() => {
  // Resolved up front: on macOS `os.tmpdir()` is itself a symlink, and the symlinks that
  // matter to these tests are the ones written below on purpose.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wr-snapshot-')));
  libraryRoot = join(dir, 'library');
  snapshotDir = join(libraryRoot, 'why-sleep-matters');
  siblingDir = join(libraryRoot, 'another-item');
  elsewhere = join(dir, 'private');
  mkdirSync(join(snapshotDir, 'assets', 'img'), { recursive: true });
  mkdirSync(siblingDir, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });

  writeFileSync(join(snapshotDir, 'page.html'), PAGE_HTML, 'utf8');
  writeFileSync(join(snapshotDir, 'assets', 'style.css'), STYLE_CSS, 'utf8');
  writeFileSync(join(snapshotDir, 'assets', 'img', 'figure-1.png'), FIGURE_PNG);
  writeFileSync(join(snapshotDir, 'notes.pdf'), 'the snapshot owns this one');
  writeFileSync(join(siblingDir, 'someone-elses.pdf'), 'a different item in the same library');
  writeFileSync(join(elsewhere, 'secrets.txt'), 'not the library at all');

  db = openDatabase({ file: join(dir, 'wiki-reader.db') }).db;
  services = { db, allowed: allowedRoots(libraryRoot), logger: silentLogger };

  pageFileId = seedFile(join(snapshotDir, 'page.html'), 'text/html; charset=utf-8', 'webpage');
  pdfFileId = seedFile(join(siblingDir, 'someone-elses.pdf'), 'application/pdf', 'pdf');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function get(fileId: string, resourcePath = ''): Promise<Awaited<ReturnType<typeof resolveFileRequest>>> {
  return resolveFileRequest(services, `rrfile://${fileId}/${resourcePath}`);
}

describe('rrfile:// serves a snapshot', () => {
  it('[W04] serves the archived page and the resources it references', async () => {
    const page = await get(pageFileId);
    expect(page.ok).toBe(true);
    expect(page.ok && page.mimeType).toBe('text/html; charset=utf-8');
    expect(page.ok && page.path).toBe(join(snapshotDir, 'page.html'));

    // The two URLs the markup above actually produces, resolved relative to the page.
    const css = await get(pageFileId, 'assets/style.css');
    expect(css.ok).toBe(true);
    expect(css.ok && css.mimeType).toBe('text/css; charset=utf-8');
    expect(css.ok && css.byteSize).toBe(STYLE_CSS.length);

    const png = await get(pageFileId, 'assets/img/figure-1.png');
    expect(png.ok).toBe(true);
    // The type comes from the resource's own extension, not from the entry page's row: the
    // snapshot has one database row and many kinds of bytes under it.
    expect(png.ok && png.mimeType).toBe('image/png');
    expect(png.ok && png.byteSize).toBe(FIGURE_PNG.length);
  });

  it('[W04] refuses a resource path that climbs out of the snapshot', async () => {
    // The form that actually reaches the handler is the one with an encoded *separator*.
    // The URL parser treats `..` and `%2e%2e` alike and collapses both, but only when they
    // stand as a whole segment; `..%2f..` is one opaque segment to it and becomes a traversal
    // only once decoded. So the boundary cannot be enforced during parsing — it has to be
    // enforced against the resolved path, which is where it now is.
    for (const escape of [
      '%2e%2e%2fanother-item%2fsomeone-elses.pdf',
      'assets/..%2f..%2fanother-item%2fsomeone-elses.pdf',
      '..%2f..%2fprivate%2fsecrets.txt',
    ]) {
      const refused = await get(pageFileId, escape);
      expect(refused.ok, `should refuse ${escape}`).toBe(false);
      expect(refused.ok === false && refused.status, `status for ${escape}`).toBe(403);
      expect(refused.ok === false && refused.reason).toBe('resource outside its snapshot');
    }

    // The unencoded forms are collapsed against the origin root before the handler sees them,
    // which leaves them pointing *inside* the snapshot at something that isn't there. Refused
    // as missing — which is what they honestly are by then — and never as the sibling's bytes.
    for (const collapsed of [
      'assets/../../another-item/someone-elses.pdf',
      '%2e%2e/another-item/someone-elses.pdf',
      '%2e%2e/%2e%2e/private/secrets.txt',
    ]) {
      const refused = await get(pageFileId, collapsed);
      expect(refused.ok, `should refuse ${collapsed}`).toBe(false);
      expect(refused.ok === false && refused.status, `status for ${collapsed}`).toBe(404);
    }

    // The sibling is inside the allowed roots and readable in its own right, which is what
    // makes the snapshot boundary a separate check rather than a restatement of the roots.
    const sibling = await get(pdfFileId);
    expect(sibling.ok).toBe(true);
  });

  it('[W04] refuses a symlink inside the snapshot that points out of it', async () => {
    // Lexically this never leaves the snapshot directory. Only resolving it does.
    symlinkSync(join(siblingDir, 'someone-elses.pdf'), join(snapshotDir, 'assets', 'shortcut.pdf'));
    const inLibrary = await get(pageFileId, 'assets/shortcut.pdf');
    expect(inLibrary.ok).toBe(false);
    expect(inLibrary.ok === false && inLibrary.status).toBe(403);
    expect(inLibrary.ok === false && inLibrary.reason).toBe('resource outside its snapshot');

    symlinkSync(join(elsewhere, 'secrets.txt'), join(snapshotDir, 'assets', 'leak.txt'));
    const outOfRoots = await get(pageFileId, 'assets/leak.txt');
    expect(outOfRoots.ok).toBe(false);
    expect(outOfRoots.ok === false && outOfRoots.status).toBe(403);
  });

  it('[W04] refuses resources under a file that is not an archived page', async () => {
    // A PDF has no resources. Allowing one would make every attachment a handle on the
    // directory it sits in, and Zotero stores unrelated items as siblings.
    const refused = await get(pdfFileId, '../why-sleep-matters/page.html');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.status).toBe(403);

    const sameDirectory = await get(pdfFileId, 'someone-elses.pdf');
    expect(sameDirectory.ok).toBe(false);
    expect(sameDirectory.ok === false && sameDirectory.reason).toBe(
      'only an archived page has resources',
    );
  });

  it('[W04] refuses an unknown file id, a malformed one, and a NUL-truncated path', async () => {
    const unknown = await resolveFileRequest(services, 'rrfile://dfl_00000000000000000000000000/');
    expect(unknown.ok === false && unknown.status).toBe(404);

    for (const bad of ['rrfile://not-an-id/', 'rrfile://dfl_short/assets/style.css', 'rrfile:///']) {
      const refused = await resolveFileRequest(services, bad);
      expect(refused.ok === false && refused.status).toBe(400);
    }

    // `page.html\0.png` is one string to a path check and a shorter one to `open(2)`.
    const truncated = await get(pageFileId, 'assets/style.css%00.png');
    expect(truncated.ok === false && truncated.status).toBe(400);
  });

  it('[W04] refuses a remote origin rather than fetching it', async () => {
    // A URL that is not this scheme never resolves to bytes, whatever the host claims to be.
    for (const remote of [
      'https://tracker.example/dfl_00000000000000000000000000/pixel.gif',
      `http://evil.example/${pageFileId}/`,
      `file:///${pageFileId}`,
    ]) {
      const refused = await resolveFileRequest(services, remote);
      expect(refused.ok, `should refuse ${remote}`).toBe(false);
      expect(refused.ok === false && refused.status).toBe(400);
    }

    // And the requests archived markup makes on its own — a tracking pixel, an analytics
    // script, a webfont from a CDN — are cancelled before they leave the machine.
    expect(blocksRemoteRequest('https://tracker.example/px.gif?read=why-sleep-matters')).toBe(true);
    expect(blocksRemoteRequest('http://cdn.example/analytics.js')).toBe(true);
    expect(blocksRemoteRequest('wss://tracker.example/socket')).toBe(true);
    expect(blocksRemoteRequest('https://localhost.tracker.example/px.gif')).toBe(true);
  });

  it('[W04] keeps `parseFileId` addressing exactly one file', async () => {
    // The single-file callers must not silently start accepting a path within a snapshot.
    expect(parseFileId(`rrfile://${pageFileId}/`)).toBe(pageFileId);
    expect(parseFileId(`rrfile://${pageFileId}/assets/style.css`)).toBeNull();

    expect(parseFileRequest(`rrfile://${pageFileId}/assets/style.css`)).toEqual({
      fileId: pageFileId,
      resourcePath: 'assets/style.css',
    });
    expect(parseFileRequest(`rrfile://${pageFileId}/`)).toEqual({
      fileId: pageFileId,
      resourcePath: '',
    });
  });
});
