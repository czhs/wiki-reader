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
import { createHtmlAnchor, extractHtmlText, snapshotMarkElementId } from '@wr/document-model';
import type { HighlightColor } from '@wr/shared-types';
import {
  blocksRemoteRequest,
  isSnapshotEntry,
  paintSnapshotHighlights,
  parseFileId,
  parseFileRequest,
  resolveFileRequest,
  snapshotSecurityHeaders,
  type FileRequestServices,
} from '../../apps/desktop/src/main/protocol.js';

const PAGE_HTML = [
  '<!doctype html>',
  '<meta charset="utf-8">',
  '<title>Why Sleep Matters</title>',
  '<link rel="stylesheet" href="assets/style.css">',
  '<h1>Why Sleep Matters</h1>',
  '<img src="assets/img/figure-1.png" alt="Sleep stages">',
  // Prose with an inline element in the middle of it, because that is where marking an
  // archived page is hard: the sentence is one run of text and the file is three.
  '<p>Sleep is when the <em>hippocampus</em> replays the day, and the replay is the point.</p>',
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

  it('[W04] serves an archived page under a policy the page itself cannot widen', () => {
    // The reader frames the page from this origin, so these headers are the last point at
    // which a policy can be attached to markup that came off the open web. A `<meta>` policy
    // in the page combines with this one as the intersection, so it can only narrow it.
    const headers = snapshotSecurityHeaders('text/html; charset=utf-8');
    const policy = headers['content-security-policy'] ?? '';

    expect(policy).toContain("default-src 'none'");
    // Not `'self'`: the frame is sandboxed without `allow-same-origin`, so its origin is
    // opaque and `'self'` would match nothing — including its own stylesheet.
    expect(policy).toContain('img-src rrfile: data:');
    expect(policy).toContain("style-src rrfile: 'unsafe-inline'");
    // Scripts, frames, workers and connections are all denied by `default-src 'none'`, and
    // naming them would only invite one to be relaxed later. What must not appear is any
    // remote origin, under any directive.
    expect(policy).not.toMatch(/https?:/);
    expect(policy).toContain('sandbox');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');

    // A PDF is not framed and is parsed by PDF.js in the renderer's own document; giving it
    // this policy would be describing a confinement it does not have.
    expect(snapshotSecurityHeaders('application/pdf')).toEqual({});
    expect(snapshotSecurityHeaders('')).toEqual({});
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

// ---------------------------------------------------------------------------
// H10 — the marks are in the bytes
// ---------------------------------------------------------------------------

/**
 * A highlight made on a saved page is painted on the page (`H10`).
 *
 * The archive is framed with `sandbox` and no tokens, so it has no script and an opaque
 * origin, and nothing in the renderer can reach into it to draw anything. That is not a
 * limitation to work around — it is the reader's whole defence against markup taken off the
 * open web. So the mark is put into the bytes on the way out, here, where the database and the
 * anchors already are, and the frame is handed a page with a few `<mark>` elements in it and
 * exactly the same absence of capability as before.
 *
 * Which makes the interesting question not "does it paint" but "when does it refuse to". An
 * anchor whose words have gone, an anchor belonging to a rendering this app does not build, a
 * request for an image rather than for the page: each has to come back with the file as it is,
 * because a mark on the wrong sentence is a claim about what the researcher read.
 */
function markPage(
  quote: string,
  over: { readonly color?: HighlightColor; readonly readerMode?: 'original' | 'readability' } = {},
): string {
  const file = db.files.getById(pageFileId);
  if (file === null) throw new Error('the fixture page has no file row');
  const anchor = createHtmlAnchor({
    selection: {
      kind: 'html',
      readerMode: over.readerMode ?? 'original',
      text: quote,
      // Exactly what the reader anchors against: the words extracted from the archive as it
      // stands, with no offsets of its own — a saved-page selection arrives from the context
      // menu as text and nothing else.
      containerText: extractHtmlText(PAGE_HTML),
      position: { start: 0, end: quote.length },
    },
    snapshotHash: file.contentHash,
  });
  return db.annotations.create({
    documentId: file.documentId,
    kind: 'highlight',
    color: over.color ?? 'default',
    selectedText: quote,
    anchor,
  }).id;
}

/** What the protocol would hand the frame, or null when it serves the file as it is. */
async function paintPage(): Promise<string | null> {
  const resolved = await get(pageFileId);
  if (!resolved.ok) throw new Error(`the page did not resolve: ${resolved.reason}`);
  return paintSnapshotHighlights(services, `rrfile://${pageFileId}/`, resolved);
}

const MARK_RE = /<mark\b[^>]*>([\s\S]*?)<\/mark>/g;

function paintedRuns(marked: string): string[] {
  return [...marked.matchAll(MARK_RE)].map((match) => match[1] ?? '');
}

function unmarked(marked: string): string {
  return marked
    .replace(/<style data-wr-snapshot-marks>[\s\S]*?<\/style>/, '')
    .replace(/<mark\b[^>]*>/g, '')
    .replace(/<\/mark>/g, '');
}

describe('a highlight is painted on the saved page itself', () => {
  it('[H10] paints the researcher’s highlight into the page, over the words it was made on', async () => {
    const annotationId = markPage('hippocampus replays the day');
    const marked = await paintPage();
    expect(marked, 'the page came back unmarked').not.toBeNull();
    if (marked === null) return;

    // Two runs, because the sentence crosses out of the `<em>` — and that is the point: a
    // single `<mark>` spanning the tag boundary is what a browser is entitled to repair by
    // painting something else. Together they are the quote and nothing but it.
    expect(paintedRuns(marked)).toEqual(['hippocampus', ' replays the day']);
    expect(marked).toContain(`id="${snapshotMarkElementId(annotationId)}"`);
    expect(marked).toContain(`data-wr-annotation="${annotationId}"`);

    // Nothing else about the archive moved. Take the marks off and it is the file, byte for
    // byte — the bytes on disk were never touched, and the copy differs by the marks alone.
    expect(unmarked(marked)).toBe(PAGE_HTML);
    // And no capability came with them. The style block is the only thing added beside the
    // marks, and inline CSS is already what the policy served with an archive allows.
    expect(marked).not.toContain('<script');
    expect(marked).toContain('<style data-wr-snapshot-marks>');
  });

  it('[H10] paints nothing at all when the words are gone, rather than the wrong sentence', async () => {
    markPage('hippocampus replays the day');
    const stillThere = markPage('Why Sleep Matters', { color: 'spruce' });

    // The page is saved again, and the sentence that highlight was made on is not in the new
    // capture. This is the case the criterion is really about: something has to give, and what
    // gives is the mark, never its position.
    const edited = PAGE_HTML.replace(
      '<p>Sleep is when the <em>hippocampus</em> replays the day, and the replay is the point.</p>',
      '<p>Sleep is when the brain does its filing.</p>',
    );
    writeFileSync(join(snapshotDir, 'page.html'), edited, 'utf8');
    db.files.upsertByPath({
      documentId: db.files.getById(pageFileId)?.documentId ?? '',
      path: join(snapshotDir, 'page.html'),
      mimeType: 'text/html; charset=utf-8',
      byteSize: statSync(join(snapshotDir, 'page.html')).size,
      contentHash: hashOf(edited),
      role: 'snapshot',
    });

    const marked = await paintPage();
    expect(marked).not.toBeNull();
    if (marked === null) return;

    // The heading is still there and is still marked; the lost highlight is simply absent.
    // Nothing was relocated onto "the brain does its filing" because it was the nearest thing.
    expect(paintedRuns(marked)).toEqual(['Why Sleep Matters']);
    expect(marked).toContain(`data-wr-annotation="${stillThere}"`);
    expect(marked).not.toContain('replays the day');
    expect(unmarked(marked)).toBe(edited);
  });

  it('[H10] refuses an anchor taken over a rendering this reader does not draw', async () => {
    // `resolveHtmlAnchor` will not resolve across reader modes, because offsets over the
    // original markup and offsets over an extracted article are two coordinate systems with
    // one shape. The page is shown as itself here, so an anchor claiming the other one has
    // nowhere to land and must not be given somewhere that merely looks right.
    markPage('hippocampus replays the day', { readerMode: 'readability' });
    expect(await paintPage()).toBeNull();

    markPage('replay is the point');
    const marked = await paintPage();
    expect(paintedRuns(marked ?? '')).toEqual(['replay is the point']);
  });

  it('[H10] paints only the page, never a resource inside the snapshot', async () => {
    markPage('hippocampus replays the day');

    expect(isSnapshotEntry(`rrfile://${pageFileId}/`, 'text/html; charset=utf-8')).toBe(true);
    expect(isSnapshotEntry(`rrfile://${pageFileId}/assets/style.css`, 'text/css')).toBe(false);
    expect(isSnapshotEntry(`rrfile://${pdfFileId}/`, 'application/pdf')).toBe(false);

    const css = await get(pageFileId, 'assets/style.css');
    expect(css.ok).toBe(true);
    if (!css.ok) return;
    expect(
      await paintSnapshotHighlights(
        services,
        `rrfile://${pageFileId}/assets/style.css`,
        css,
      ),
    ).toBeNull();
  });

  it('[H10] serves the marks again to a process that never saw them made', async () => {
    const annotationId = markPage('hippocampus replays the day', { color: 'ochre' });
    expect(await paintPage()).not.toBeNull();

    // A restart, as far as anything here is concerned: the database is closed and reopened
    // from the same file, and the marks come from the anchors rather than from anything the
    // first process kept. Nothing was written into the archive to make this work.
    db.close();
    db = openDatabase({ file: join(dir, 'wiki-reader.db') }).db;
    services = { db, allowed: allowedRoots(libraryRoot), logger: silentLogger };

    const marked = await paintPage();
    expect(marked).not.toBeNull();
    if (marked === null) return;
    expect(paintedRuns(marked)).toEqual(['hippocampus', ' replays the day']);
    expect(marked).toContain(`data-wr-annotation="${annotationId}"`);
    expect(marked).toContain('data-wr-color="ochre"');
    expect(unmarked(marked)).toBe(PAGE_HTML);
  });
});
