/**
 * A highlight on a saved web page, from the selection that made it to the one that resolves
 * after a restart — over a real archived page on disk, the real Zotero import, and a real
 * SQLite file.
 *
 * "Survives restart" is taken literally, as in the markdown case: the database is closed and
 * reopened from the same path between making the highlight and finding it again, and the
 * anchor is rebuilt from the snapshot's bytes each time. Nothing under test is carried across
 * in memory.
 *
 * The three cases are the ones that separate an anchor from a stored offset. A snapshot the
 * app captured and never touches is the easy case. The interesting ones are the page saved
 * again after the site edited it — every offset after the insertion is now wrong — and the
 * page whose highlighted sentence is gone, where the only honest answer is that the highlight
 * is lost. A plausible-looking wrong paragraph would be worse than none: it reads as a finding.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WikiReaderDatabase } from '@wr/database';
import { ZoteroImporter, ZoteroLocalClient } from '@wr/zotero-adapter';
import { deserializeHtmlAnchor, extractHtmlText, normalizeText, resolveHtmlAnchor } from '@wr/document-model';
import type { HtmlReaderSelection } from '@wr/shared-types';
// Imported by path for the reason the markdown test gives: the package entrypoint pulls in
// React, and this suite runs in a node environment where the anchor maths is the whole point.
import { createHtmlAnchorFromSelection } from '../../packages/html-reader/src/anchoring.js';
import { fixtureFetch } from '../../packages/zotero-adapter/test/fake-api.js';

const ZOTERO_FIXTURES = fileURLToPath(
  new URL('../../packages/zotero-adapter/test/fixtures/', import.meta.url),
);
/** The data-directory prefix baked into the recorded `enclosure` hrefs. */
const RECORDED_DATA_DIR_URL = 'file:///Users/testuser/Zotero';

interface RecordedItem {
  readonly data: {
    readonly key: string;
    readonly itemType: string;
    readonly version: number;
    readonly contentType?: string;
  };
  readonly links?: Record<string, { href: string }>;
}
type RecordedAttachment = RecordedItem;

/** The sentence the reader drags over, and the paragraph it lives in. */
const QUOTE = 'the field rewards reading code more than reading papers';

function page(body: readonly string[]): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>How to become a mechanistic interpretability researcher</title>',
    '<link rel="stylesheet" href="assets/page.css">',
    '</head><body>',
    '<h1>How to become a mechanistic interpretability researcher</h1>',
    ...body,
    '</body></html>',
    '',
  ].join('\n');
}

const ORIGINAL = page([
  '<p>People ask how to start, and the honest answer is unglamorous.</p>',
  `<p>The first thing to understand is that ${QUOTE}.</p>`,
  '<p>The second is that the experiments are cheap enough to run before arguing.</p>',
]);

/** The same page saved again after the site added a section above the quote. */
const RESAVED = page([
  '<p>People ask how to start, and the honest answer is unglamorous.</p>',
  '<h2>Prerequisites</h2>',
  '<p>You need enough linear algebra to read an attention head without flinching, and',
  '   enough patience to read a training loop twice.</p>',
  `<p>The first thing to understand is that ${QUOTE}.</p>`,
  '<p>The second is that the experiments are cheap enough to run before arguing.</p>',
]);

/**
 * The page as `H01` actually meets it: markup the reader never showed, inside the sentence.
 *
 * `extractHtmlText` is a scanner over the archive, not a rendering of it, so it emits prose
 * that was `display:none` on screen — one real archived page in this suite's fixtures carries
 * 247 hidden table-of-contents elements. Chromium's selection is the opposite: it reports what
 * was visible. So the words the researcher marked need not occur verbatim in the extracted
 * text, and this page is the smallest honest version of that.
 *
 * The padding is not decoration either. The saved-page selection carries no offsets, so the
 * hint is always the top of the page, and the fuzzy pass is bounded to a radius around its
 * hint — anything further down than that was never searched at all.
 */
const HIDDEN_MARKUP = page([
  '<p>People ask how to start, and the honest answer is unglamorous.</p>',
  ...Array.from(
    { length: 40 },
    (_, index) =>
      `<p>Paragraph ${String(index)} of preamble, long enough that the sentence below sits well past` +
      ' the distance a hint-bounded search would ever reach, and saying nothing of interest' +
      ' while it gets there. It is here to put distance between the top of the page and the' +
      ' words somebody marked.</p>',
  ),
  `<p>The first thing to understand is that the field <span style="display:none">[edit]</span>` +
    `rewards reading code more than reading papers.</p>`,
  '<p>The second is that the experiments are cheap enough to run before arguing.</p>',
]);

/** The same page saved again after that sentence was rewritten away entirely. */
const REWRITTEN = page([
  '<p>People ask how to start, and the honest answer is unglamorous.</p>',
  '<p>Nothing in this paragraph resembles what was highlighted.</p>',
  '<p>The second is that the experiments are cheap enough to run before arguing.</p>',
]);

let dir: string;
let zoteroDataDir: string;
let databasePath: string;
let db: WikiReaderDatabase;
let topItems: RecordedItem[];
let children: RecordedAttachment[];
/** Every archived page the import materialized, by path on disk. */
let snapshotPaths: string[];

async function loadFixture(name: string): Promise<RecordedItem[]> {
  return JSON.parse(await readFile(join(ZOTERO_FIXTURES, name), 'utf8')) as RecordedItem[];
}

/**
 * Advance every item's Zotero version, as saving a page again does upstream.
 *
 * This is what makes the re-import a real one. `ZoteroImporter` skips an item whose version
 * is unchanged — and skipping the item skips its attachments, so the bytes are never
 * re-hashed. Rewriting the file without bumping the version would leave the database holding
 * the old hash, and a test built on that would be asserting against a stale row rather than
 * against a page that was saved again.
 */
function bumped(items: readonly RecordedItem[]): RecordedItem[] {
  return items.map((item) => ({ ...item, data: { ...item.data, version: item.data.version + 1 } }));
}

/**
 * Rewrite the recorded `enclosure` hrefs onto this test's data directory — the same
 * relocation that happens when a library is opened on a different machine.
 */
function relocate(recorded: readonly RecordedAttachment[]): RecordedAttachment[] {
  const prefix = pathToFileURL(zoteroDataDir).href.replace(/\/$/, '');
  return recorded.map((child) => {
    const enclosure = child.links?.['enclosure']?.href;
    if (enclosure === undefined || !enclosure.startsWith(RECORDED_DATA_DIR_URL)) return child;
    return {
      ...child,
      links: {
        ...child.links,
        enclosure: { href: prefix + enclosure.slice(RECORDED_DATA_DIR_URL.length) },
      },
    };
  });
}

/** Put bytes where the relocated fixtures say the attachments are. */
function materialize(html: string): void {
  snapshotPaths = [];
  for (const child of children) {
    const enclosure = child.links?.['enclosure']?.href;
    if (child.data.itemType !== 'attachment' || enclosure === undefined) continue;
    const path = fileURLToPath(enclosure);
    mkdirSync(dirname(path), { recursive: true });
    if (child.data.contentType === 'text/html') {
      writeFileSync(path, html, 'utf8');
      snapshotPaths.push(path);
    } else {
      // A PDF the reader never opens here. Real bytes are not needed for what is under test,
      // but the file has to exist or the importer records it as missing.
      writeFileSync(path, '%PDF-1.4\n% not read by this suite\n');
    }
  }
}

/** Run the real Zotero import against the fixtures, as the app does at startup. */
async function importLibrary(): Promise<void> {
  const client = new ZoteroLocalClient({ fetch: fixtureFetch({ items: topItems, children }) });
  const summary = await new ZoteroImporter(client, db, { dataDir: zoteroDataDir }).import();
  if (summary.filesMissing > 0) {
    throw new Error(`the import found ${String(summary.filesMissing)} attachment(s) with no bytes`);
  }
}

/** The saved-page document the import produced, with the file row the reader would be handed. */
function savedPage(): { id: string; path: string; contentHash: string } {
  const { items } = db.library.list({});
  const item = items.find((candidate) => candidate.document.docType === 'webpage');
  if (item === undefined) throw new Error('the import produced no saved web page');
  const file = item.files.find((candidate) => candidate.role === 'primary');
  if (file === undefined) throw new Error('the saved page has no primary file');
  const row = db.files.listByDocument(item.document.id).find((candidate) => candidate.id === file.id);
  if (row === undefined) throw new Error('the file row vanished between reads');
  return { id: item.document.id, path: row.path, contentHash: row.contentHash };
}

/**
 * Build the selection the reader would emit for `quote`.
 *
 * The offsets are against the *extracted, normalized text of the snapshot* — not against the
 * DOM inside the iframe, which is one rendering of an archive that may be replaced. That is
 * the same derivation the markdown reader makes for the same reason.
 */
function selectionFor(html: string, quote: string): HtmlReaderSelection {
  const containerText = normalizeText(extractHtmlText(html));
  const start = containerText.indexOf(quote);
  if (start === -1) throw new Error(`the snapshot does not contain "${quote}"`);
  return {
    kind: 'html',
    readerMode: 'original',
    text: quote,
    containerText,
    position: { start, end: start + quote.length },
    sectionPath: 'How to become a mechanistic interpretability researcher',
  };
}

/** Close and reopen the database from the same file — the restart these criteria are about. */
function restart(): void {
  db.close();
  db = openDatabase({ file: databasePath }).db;
}

/** Read the snapshot back off disk and resolve the stored anchor against it. */
async function resolveStoredAnchor(
  documentId: string,
): Promise<{ text: string; strategy: string; confidence: number } | null> {
  const stored = db.annotations.listByDocument(documentId);
  const only = stored[0];
  if (only === undefined) throw new Error('the highlight did not survive the restart');

  const { path, contentHash } = savedPage();
  const html = await readFile(path, 'utf8');
  const documentText = normalizeText(extractHtmlText(html));

  const anchor = deserializeHtmlAnchor(JSON.stringify(only.anchor));
  const resolved = resolveHtmlAnchor({ anchor, documentText, snapshotHash: contentHash });
  if (resolved === null) return null;
  if (resolved.location.kind !== 'html') throw new Error('resolved to a non-html location');
  const range = resolved.location.textRange;
  if (range === undefined) throw new Error('an html location with no text range');

  return {
    text: documentText.slice(range.start, range.end),
    strategy: resolved.strategy,
    confidence: resolved.confidence,
  };
}

/** Import the library, highlight `QUOTE` on the saved page, and return its document id. */
async function highlightTheQuote(): Promise<string> {
  await importLibrary();
  const { id, path, contentHash } = savedPage();
  const html = await readFile(path, 'utf8');

  db.annotations.create({
    documentId: id,
    kind: 'highlight',
    color: 'default',
    selectedText: QUOTE,
    anchor: createHtmlAnchorFromSelection(selectionFor(html, QUOTE), contentHash),
  });

  return id;
}

/**
 * Save every archived page again, between two runs of the app.
 *
 * The database is closed first because that is when this happens: the user is in Zotero, not
 * in the reader. New bytes on disk, a new version upstream, and a fresh import on the next
 * start — the anchor has to survive all three.
 */
async function resaveAs(html: string): Promise<void> {
  db.close();
  for (const path of snapshotPaths) writeFileSync(path, html, 'utf8');
  topItems = bumped(topItems);
  children = bumped(children);
  db = openDatabase({ file: databasePath }).db;
  await importLibrary();
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wr-html-highlight-')));
  zoteroDataDir = join(dir, 'Zotero');
  databasePath = join(dir, 'wiki-reader.db');
  mkdirSync(zoteroDataDir, { recursive: true });

  topItems = await loadFixture('items-top.json');
  children = relocate(await loadFixture('items-children.json'));
  materialize(ORIGINAL);
  db = openDatabase({ file: databasePath }).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('web-snapshot highlights', () => {
  it('[W05] restores a highlight on a saved page over the same text after a restart', async () => {
    const documentId = await highlightTheQuote();

    restart();

    // Stored, not remembered: read from a database that was closed and reopened.
    const stored = db.annotations.listByDocument(documentId);
    expect(stored).toHaveLength(1);
    const only = stored[0];
    expect(only).toBeDefined();
    if (only === undefined) return;
    expect(only.kind).toBe('highlight');
    expect(only.selectedText).toBe(QUOTE);

    // Textual evidence, not pixel geometry — the invariant that lets a re-saved page still
    // be anchored into. And `readerMode`, without which offsets from two different
    // renderings are indistinguishable.
    expect(only.anchor.kind).toBe('html');
    if (only.anchor.kind !== 'html') return;
    expect(only.anchor.quote.exact).toBe(QUOTE);
    expect(only.anchor.quote.prefix.length).toBeGreaterThan(0);
    expect(only.anchor.snapshotHash.length).toBeGreaterThan(0);
    expect(only.anchor.readerMode).toBe('original');

    // And it lands back on the same words, by offset, because nothing moved.
    const resolved = await resolveStoredAnchor(documentId);
    expect(resolved).not.toBeNull();
    expect(resolved?.text).toBe(QUOTE);
    expect(resolved?.strategy).toBe('exact-position');
    expect(resolved?.confidence).toBe(1);
  });

  it('[W05] re-finds the highlight after the page was saved again with new text above it', async () => {
    const documentId = await highlightTheQuote();
    const before = savedPage().contentHash;

    await resaveAs(RESAVED);

    // The re-import hashed different bytes, so the stored offsets cannot be trusted…
    const after = savedPage().contentHash;
    expect(after).not.toBe(before);
    const stored = db.annotations.listByDocument(documentId)[0];
    expect(stored).toBeDefined();
    if (stored === undefined || stored.anchor.kind !== 'html') return;
    expect(after).not.toBe(stored.anchor.snapshotHash);

    // …and the quote is re-found by its context instead, still over the words the user chose.
    const resolved = await resolveStoredAnchor(documentId);
    expect(resolved).not.toBeNull();
    expect(resolved?.text).toBe(QUOTE);
    expect(resolved?.strategy).not.toBe('exact-position');
    expect(resolved?.confidence).toBeGreaterThan(0);
  });

  it('[W05] reports a highlight as lost rather than moving it to different words', async () => {
    const documentId = await highlightTheQuote();

    await resaveAs(REWRITTEN);

    expect(await resolveStoredAnchor(documentId)).toBeNull();
    // The annotation itself is kept: the text it pointed at is gone, but the user's note
    // about it is not the application's to delete.
    expect(db.annotations.listByDocument(documentId)).toHaveLength(1);
  });

  /**
   * The anchor `H01` builds, on a page whose extracted text is not what the reader saw.
   *
   * A selection out of the context menu is words with no offsets, so the panel hands
   * `createHtmlAnchor` a hint of "the top of the page". When the words are found, that hint only
   * breaks ties. When they are not, the hint used to be *kept*: it became the anchor's recorded
   * position, and `createQuoteSelector` then cut the prefix and suffix from there — an anchor
   * persisted with confident context describing a passage nobody marked, which `scoreContext`
   * later uses to choose between occurrences. And because the fuzzy pass is bounded around the
   * hint, a sentence further down the page than that radius was never searched: the highlight
   * was created, listed, struck through, and permanently unfindable.
   */
  it('[H01] records no offsets and no context when the words are not in the extracted text', async () => {
    materialize(HIDDEN_MARKUP);
    await importLibrary();
    const { id, path, contentHash } = savedPage();
    const html = await readFile(path, 'utf8');
    const containerText = normalizeText(extractHtmlText(html));
    // The premise: what the researcher selected is not in the extracted text verbatim.
    expect(containerText).not.toContain(QUOTE);
    expect(containerText).toContain('the field [edit]rewards reading code');
    expect(containerText.indexOf('[edit]')).toBeGreaterThan(4_000);

    // Exactly what the article panel builds from a context-menu selection: the words, and a
    // position hint of the top of the page, because the frame grants nothing else.
    const anchor = createHtmlAnchorFromSelection(
      {
        kind: 'html',
        readerMode: 'original',
        text: QUOTE,
        containerText,
        position: { start: 0, end: QUOTE.length },
      },
      contentHash,
    );

    expect(anchor.position).toBeUndefined();
    expect(anchor.quote.exact).toBe(QUOTE);
    expect(anchor.quote.prefix).toBe('');
    expect(anchor.quote.suffix).toBe('');

    db.annotations.create({
      documentId: id,
      kind: 'highlight',
      color: 'default',
      selectedText: QUOTE,
      anchor,
    });
    restart();

    const resolved = await resolveStoredAnchor(id);
    expect(resolved).not.toBeNull();
    // Where the reader actually dragged, found by searching the page rather than the first
    // four thousand characters of it.
    expect(resolved?.text).toContain('rewards reading code more than reading');
    expect(containerText.indexOf(resolved?.text ?? 'x')).toBeGreaterThan(4_000);
  });

  it('[W05] refuses to resolve an anchor against a different rendering of the page', async () => {
    const documentId = await highlightTheQuote();
    restart();

    const stored = db.annotations.listByDocument(documentId)[0];
    expect(stored).toBeDefined();
    if (stored === undefined || stored.anchor.kind !== 'html') return;

    const { path } = savedPage();
    const documentText = normalizeText(extractHtmlText(await readFile(path, 'utf8')));

    // Offsets over the original markup and offsets over an extracted-article rendering are
    // different coordinate systems that happen to have the same shape. Resolving one against
    // the other would land the highlight on unrelated words at full confidence, so it is
    // refused outright rather than attempted.
    expect(
      resolveHtmlAnchor({ anchor: stored.anchor, documentText, readerMode: 'readability' }),
    ).toBeNull();
    expect(
      resolveHtmlAnchor({ anchor: stored.anchor, documentText, readerMode: 'original' }),
    ).not.toBeNull();
  });
});
