/**
 * A markdown highlight, from the selection that made it to the one that resolves after a
 * restart — over a real corpus file, the real importer, and a real SQLite file.
 *
 * "Survives restart" is taken literally here: the database is closed and reopened from the
 * same path between making the highlight and finding it again, so nothing under test is
 * carried across in memory. The anchor is rebuilt from the bytes on disk each time.
 *
 * The case that matters is the second one. A markdown file is text the user owns and edits in
 * other tools, so between two runs of the app the file can have moved underneath the anchor.
 * There is no geometry to fall back on, which is why the evidence is a quote and its context:
 * offsets alone would silently point at the wrong paragraph.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WikiReaderDatabase } from '@wr/database';
import {
  deserializeMarkdownAnchor,
  normalizeText,
  parseMarkdown,
  resolveMarkdownAnchor,
} from '@wr/document-model';
import type { MarkdownReaderSelection } from '@wr/shared-types';
// Imported by path, like the main-process modules below: the package's entrypoint pulls in
// React, and this suite runs in a node environment where the anchor maths is the whole point.
import { createMarkdownAnchorFromSelection } from '../../packages/markdown-reader/src/anchoring.js';
import { MarkdownCorpusImporter } from '../../apps/desktop/src/main/corpus.js';
import { allowedRoots } from '../../apps/desktop/src/main/paths.js';

const PAGE = 'Spaced Repetition.md';
const SLUG = 'spaced-repetition';

const ORIGINAL = [
  '# Spaced repetition',
  '',
  'Recall is strongest when review is spread out rather than massed into one sitting.',
  '',
  '## Scheduling',
  '',
  'Intervals grow after each successful recall, which is the whole mechanism.',
  '',
].join('\n');

/** The sentence the reader drags over. */
const QUOTE = 'Intervals grow after each successful recall';

let dir: string;
let corpusRoot: string;
let databasePath: string;
let db: WikiReaderDatabase;

function write(name: string, body: string): void {
  writeFileSync(join(corpusRoot, name), body, 'utf8');
}

function importer(): MarkdownCorpusImporter {
  return new MarkdownCorpusImporter(db, { root: corpusRoot, allowed: allowedRoots(corpusRoot) });
}

/** Close and reopen the database from the same file — the restart these criteria are about. */
function restart(): void {
  db.close();
  db = openDatabase({ file: databasePath }).db;
}

/** The document a corpus file became, with the file row the reader would be handed. */
function corpusDocument(slug: string): { id: string; path: string; contentHash: string } {
  const document = db.documents.getBySlug(slug);
  if (document === null) throw new Error(`no document for slug ${slug}`);
  const file = db.files.listByDocument(document.id).find((row) => row.role === 'primary');
  if (file === undefined) throw new Error(`no primary file for slug ${slug}`);
  return { id: document.id, path: file.path, contentHash: file.contentHash };
}

/**
 * Build the selection the reader would emit for `quote`.
 *
 * Deliberately the same derivation `MarkdownReaderView` performs: offsets are computed against
 * the *normalized document text*, not against the DOM, because the DOM is one rendering of the
 * file and the file is what the anchor has to survive.
 */
function selectionFor(source: string, quote: string): MarkdownReaderSelection {
  const documentText = normalizeText(parseMarkdown(source).text);
  const start = documentText.indexOf(quote);
  if (start === -1) throw new Error(`the corpus page does not contain "${quote}"`);
  return {
    kind: 'markdown',
    text: quote,
    documentText,
    position: { start, end: start + quote.length },
    headingPath: 'scheduling',
  };
}

/** Read the page back off disk and resolve a stored anchor against it, as reopening would. */
async function resolveStoredAnchor(
  documentId: string,
): Promise<{ text: string; strategy: string; confidence: number } | null> {
  const stored = db.annotations.listByDocument(documentId);
  const only = stored[0];
  if (only === undefined) throw new Error('the highlight did not survive the restart');

  const { path, contentHash } = corpusDocument(SLUG);
  const source = await readFile(path, 'utf8');
  const documentText = normalizeText(parseMarkdown(source).text);

  const anchor = deserializeMarkdownAnchor(JSON.stringify(only.anchor));
  const resolved = resolveMarkdownAnchor({ anchor, documentText, sourceHash: contentHash });
  if (resolved === null) return null;
  if (resolved.location.kind !== 'markdown') throw new Error('resolved to a non-markdown location');

  const { start, end } = resolved.location.textRange;
  return {
    text: documentText.slice(start, end),
    strategy: resolved.strategy,
    confidence: resolved.confidence,
  };
}

/** Import the corpus, highlight `QUOTE`, and return the document it belongs to. */
async function highlightTheQuote(): Promise<string> {
  await importer().import();
  const { id, contentHash } = corpusDocument(SLUG);

  db.annotations.create({
    documentId: id,
    kind: 'highlight',
    color: 'default',
    selectedText: QUOTE,
    anchor: createMarkdownAnchorFromSelection(selectionFor(ORIGINAL, QUOTE), contentHash),
  });

  return id;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wr-md-highlight-')));
  corpusRoot = join(dir, 'corpus');
  databasePath = join(dir, 'wiki-reader.db');
  mkdirSync(corpusRoot, { recursive: true });
  db = openDatabase({ file: databasePath }).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('markdown highlights', () => {
  it('[W02] restores a markdown highlight over the same text after a restart', async () => {
    write(PAGE, ORIGINAL);
    const documentId = await highlightTheQuote();

    restart();

    // Stored, not remembered: the row is read from a database that was closed and reopened.
    const stored = db.annotations.listByDocument(documentId);
    expect(stored).toHaveLength(1);
    const only = stored[0];
    expect(only).toBeDefined();
    if (only === undefined) return;
    expect(only.kind).toBe('highlight');
    expect(only.selectedText).toBe(QUOTE);

    // The anchor carries textual evidence, not only offsets — the invariant that lets a file
    // edited outside the app still be anchored into.
    expect(only.anchor.kind).toBe('markdown');
    if (only.anchor.kind !== 'markdown') return;
    expect(only.anchor.quote.exact).toBe(QUOTE);
    expect(only.anchor.documentTextHash.length).toBeGreaterThan(0);
    expect(only.anchor.sourceHash.length).toBeGreaterThan(0);
    expect(only.anchor.headingPath).toBe('scheduling');

    // And it lands back on the same words, by offset, because nothing moved.
    const resolved = await resolveStoredAnchor(documentId);
    expect(resolved).not.toBeNull();
    expect(resolved?.text).toBe(QUOTE);
    expect(resolved?.strategy).toBe('exact-position');
    expect(resolved?.confidence).toBe(1);
  });

  it('[W02] re-finds the highlight after the file was edited outside the app', async () => {
    write(PAGE, ORIGINAL);
    const documentId = await highlightTheQuote();

    db.close();
    // Between the two runs the user edited the page in another editor: a whole section was
    // inserted above the highlight, so every stored offset is now wrong by that much.
    write(
      PAGE,
      ORIGINAL.replace(
        '## Scheduling',
        ['## Evidence', '', 'The effect replicates across decades of list-learning studies.', '', '## Scheduling'].join('\n'),
      ),
    );
    db = openDatabase({ file: databasePath }).db;
    await importer().import();

    // The re-import saw different bytes, so resolution cannot trust the offsets…
    const { contentHash } = corpusDocument(SLUG);
    const stored = db.annotations.listByDocument(documentId)[0];
    expect(stored).toBeDefined();
    if (stored === undefined || stored.anchor.kind !== 'markdown') return;
    expect(contentHash).not.toBe(stored.anchor.sourceHash);

    // …and re-finds the quote by its context instead, still over the words the user chose.
    const resolved = await resolveStoredAnchor(documentId);
    expect(resolved).not.toBeNull();
    expect(resolved?.text).toBe(QUOTE);
    expect(resolved?.strategy).not.toBe('exact-position');
    expect(resolved?.confidence).toBeGreaterThan(0);
  });

  it('[W02] reports a highlight as lost rather than moving it to different words', async () => {
    write(PAGE, ORIGINAL);
    const documentId = await highlightTheQuote();

    db.close();
    // The highlighted sentence was deleted outright. There is no honest place to put the
    // highlight, and a plausible-looking wrong paragraph would be worse than none.
    write(
      PAGE,
      ORIGINAL.replace(
        'Intervals grow after each successful recall, which is the whole mechanism.',
        'Nothing here resembles what was highlighted.',
      ),
    );
    db = openDatabase({ file: databasePath }).db;
    await importer().import();

    expect(await resolveStoredAnchor(documentId)).toBeNull();
    // The annotation itself is kept: the text it pointed at is gone, but the user's note about
    // it is not the application's to delete.
    expect(db.annotations.listByDocument(documentId)).toHaveLength(1);
  });
});
