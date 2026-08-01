/**
 * Vertical-slice integration tests (M08, M09, M10, M12, M13, M14).
 *
 * These drive the *real* stack: the real IPC router with its zod validation, the real
 * handlers, a real on-disk SQLite database with the real migrations, the real PDF.js text
 * extractor over a real PDF, the real FTS5 index, and the real search service. Nothing here
 * is mocked. The only thing absent is Electron itself, which contributes no behaviour to any
 * of these criteria — the main process deliberately keeps `services.ts`, `handlers.ts`, and
 * `pipeline.ts` free of Electron imports precisely so this is possible.
 *
 * "Survives restart" is tested literally: the service container is closed, the process-level
 * handle to the database is dropped, and a brand-new container is opened against the same
 * file. Anything that only lived in memory is gone by construction.
 */
import { createHash } from 'node:crypto';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPdfAnchor, mintId, resolvePdfAnchor } from '@wr/document-model';
import { extractPdfText } from '@wr/text-extraction-worker';
import type {
  AnnotationWithAnchor,
  DocumentLocation,
  PdfAnchor,
  PdfReaderSelection,
} from '@wr/shared-types';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';
import { IntegrationWorkspace } from './support/workspace.js';

const FIXTURE_PDF = fileURLToPath(new URL('../fixtures/sample-paper.pdf', import.meta.url));

/** Terms that occur on exactly one page of the fixture. Asserted below, not assumed. */
const PAGE_UNIQUE_TERMS: readonly { term: string; pageIndex: number }[] = [
  { term: 'sinusoidal', pageIndex: 0 },
  { term: 'warmup', pageIndex: 1 },
  { term: 'reproducible', pageIndex: 2 },
];

/**
 * Ground truth for what is on each page, obtained by running the extractor over the fixture
 * directly. Assertions about which page a search hit belongs to are checked against this
 * rather than against the index that produced the hit, so the index cannot mark its own work.
 */
let fixturePages: readonly string[] = [];

beforeAll(async () => {
  const extracted = await extractPdfText(new Uint8Array(readFileSync(FIXTURE_PDF)));
  fixturePages = extracted.pages.map((page) => page.text);

  // The premise of every page-mapping assertion in this file.
  expect(fixturePages).toHaveLength(3);
  for (const { term, pageIndex } of PAGE_UNIQUE_TERMS) {
    const pagesWithTerm = fixturePages
      .map((text, index) => (text.toLowerCase().includes(term) ? index : -1))
      .filter((index) => index >= 0);
    expect(pagesWithTerm, `"${term}" is not unique to one page`).toEqual([pageIndex]);
  }
});

/**
 * One test workspace: a temp directory holding the database, and a service container that
 * can be torn down and rebuilt against the same file to simulate an application restart.
 */
class Workspace extends IntegrationWorkspace {
  constructor() {
    // The fixture PDF lives in the repository, not under a Zotero data directory, so the
    // path allow-list has to be told about it explicitly. The check itself is the real one.
    super('wr-integration-', () => ({
      extraRoots: [fileURLToPath(new URL('../fixtures', import.meta.url))],
    }));
  }
}

/** Seed one document whose primary file is the real fixture PDF. */
function seedDocument(workspace: Workspace, title = 'Attention Mechanisms in Sequence Models'): {
  documentId: string;
  fileId: string;
  contentHash: string;
} {
  const { db } = workspace.services;
  // The same hash the Zotero importer computes for a linked attachment.
  const contentHash = createHash('sha256').update(readFileSync(FIXTURE_PDF)).digest('hex');

  const document = db.documents.create({
    title,
    docType: 'pdf',
    source: 'zotero',
    authors: [{ family: 'Vaswani', given: 'A.' }],
  });
  const { file } = db.files.upsertByPath({
    documentId: document.id,
    path: FIXTURE_PDF,
    mimeType: 'application/pdf',
    byteSize: statSync(FIXTURE_PDF).size,
    contentHash,
    role: 'primary',
  });

  return { documentId: document.id, fileId: file.id, contentHash };
}

/** Run extraction + indexing exactly as the app does, then wait for the queue to drain. */
async function extractAndIndex(workspace: Workspace, documentId: string): Promise<void> {
  const { queued } = await workspace.call('document:requestExtraction', { documentId });
  expect(queued).toBe(true);
  // The handler kicks a drain it does not await, so the renderer is not blocked on PDF
  // parsing. Awaiting `drain()` here joins that in-flight drain if it is still running and
  // otherwise starts a fresh one; either way the queue is empty and every job is terminal by
  // the time it resolves. The drain's own counters are therefore *not* a reliable assertion
  // target from here — the durable job rows are, so that is what gets checked.
  await workspace.services.pipeline.drain();
  expect(workspace.services.db.jobs.listFailed()).toEqual([]);
}

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(() => {
  workspace.dispose();
});

// ---------------------------------------------------------------------------
// M08 — reading position is persisted
// ---------------------------------------------------------------------------

describe('reading position', () => {
  it('[M08] restores the saved reading position after restart', async () => {
    const { documentId } = seedDocument(workspace);

    const location: DocumentLocation = { kind: 'pdf', pageIndex: 2, pageOffsetRatio: 0.42 };
    const saved = await workspace.call('document:setReadingPosition', { documentId, location });
    expect(saved.position.location).toEqual(location);

    workspace.restart();

    const restored = await workspace.call('document:getReadingPosition', { documentId });
    expect(restored.position).not.toBeNull();
    expect(restored.position?.location).toEqual(location);
    expect(restored.position?.documentId).toBe(documentId);
  });

  it('[M08] overwrites rather than accumulates positions for the same document', async () => {
    const { documentId } = seedDocument(workspace);

    await workspace.call('document:setReadingPosition', {
      documentId,
      location: { kind: 'pdf', pageIndex: 0 },
    });
    await workspace.call('document:setReadingPosition', {
      documentId,
      location: { kind: 'pdf', pageIndex: 1, pageOffsetRatio: 0.5 },
    });

    workspace.restart();

    const restored = await workspace.call('document:getReadingPosition', { documentId });
    expect(restored.position?.location).toEqual({
      kind: 'pdf',
      pageIndex: 1,
      pageOffsetRatio: 0.5,
    });
  });

  it('[M08] reports no position for a document that was never opened', async () => {
    const { documentId } = seedDocument(workspace);
    const restored = await workspace.call('document:getReadingPosition', { documentId });
    expect(restored.position).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M09 — PDF text is extracted and added to FTS5
// ---------------------------------------------------------------------------

describe('extraction and indexing', () => {
  it('[M09] extracts real PDF text and makes every page searchable in FTS5', async () => {
    const { documentId } = seedDocument(workspace);

    const before = await workspace.call('search:status', {});
    expect(before.indexedDocuments).toBe(0);

    await extractAndIndex(workspace, documentId);

    const after = await workspace.call('search:status', {});
    expect(after.indexedDocuments).toBe(1);
    expect(after.totalDocuments).toBe(1);
    expect(after.failed).toBe(0);

    // Every page of the real fixture is covered by at least one chunk carrying real extracted
    // text, in page order. The count is not pinned to the page count: the chunker splits a
    // page that exceeds `DEFAULT_MAX_CHUNK_CHARS`, and page 2 of this fixture does.
    const chunks = workspace.services.db.chunks.listForDocument(documentId);
    const coveredPages = [...new Set(chunks.map((chunk) => chunk.pageIndex))];
    expect(coveredPages).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      [...chunks].map((_, index) => index),
    );
    expect(chunks[0]?.text).toContain('scaled dot-product attention');

    // Each chunk's stored text is exactly the page range it claims to cover, so a hit's
    // `textRange` maps back into the page text rather than into a re-flowed copy of it.
    for (const chunk of chunks) {
      const page = fixturePages[chunk.pageIndex ?? -1];
      expect(page, `chunk ${chunk.id} points at a page that was not extracted`).toBeDefined();
      expect(chunk.text).toBe((page ?? '').slice(chunk.charStart ?? 0, chunk.charEnd ?? 0));
    }

    // Every page is reachable through FTS5, not merely stored.
    for (const { term } of PAGE_UNIQUE_TERMS) {
      const found = await workspace.call('search:query', { query: term });
      expect(found.results.length, `no FTS5 hit for "${term}"`).toBeGreaterThan(0);
    }
  });

  it('[M09] keeps the index consistent when the same document is extracted twice', async () => {
    const { documentId } = seedDocument(workspace);

    await extractAndIndex(workspace, documentId);
    const first = await workspace.call('search:query', { query: 'sinusoidal' });
    const firstChunkCount = workspace.services.db.chunks.listForDocument(documentId).length;
    expect(firstChunkCount).toBeGreaterThan(0);

    await extractAndIndex(workspace, documentId);
    const second = await workspace.call('search:query', { query: 'sinusoidal' });

    // Re-extraction must not duplicate chunks or index entries.
    const chunks = workspace.services.db.chunks.listForDocument(documentId);
    expect(chunks).toHaveLength(firstChunkCount);
    expect(new Set(chunks.map((chunk) => chunk.chunkIndex)).size).toBe(chunks.length);
    expect(second.results).toHaveLength(first.results.length);
    expect((await workspace.call('search:status', {})).indexedDocuments).toBe(1);
  });

  it('[M09] records a failure instead of silently skipping an unreadable file', async () => {
    const { db } = workspace.services;
    const document = db.documents.create({ title: 'Missing', docType: 'pdf', source: 'zotero' });
    db.files.upsertByPath({
      documentId: document.id,
      // Inside an allowed root, so the path guard passes and the *read* is what fails. This
      // is the case that matters: a file Zotero told us about that is no longer on disk.
      path: fileURLToPath(new URL('../fixtures/does-not-exist.pdf', import.meta.url)),
      mimeType: 'application/pdf',
      byteSize: 1,
      contentHash: 'deadbeef',
      role: 'primary',
    });

    await workspace.call('document:requestExtraction', { documentId: document.id });
    await workspace.services.pipeline.drain();

    // The durable record is the criterion: a document that cannot be extracted must be
    // distinguishable from one that simply has not been extracted yet.
    const failures = db.jobs.listFailed();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.documentId).toBe(document.id);
    expect(failures[0]?.status).toBe('failed');
    expect(failures[0]?.error ?? '').toMatch(/ENOENT|no such file/i);

    // And it is visible to the renderer, not just in the table.
    const status = await workspace.call('search:status', {});
    expect(status.failed).toBe(1);
    expect(status.queued).toBe(0);
    expect(status.indexedDocuments).toBe(0);
  });

  it('[M09] refuses to extract a file outside the allowed roots', async () => {
    const { db, pipeline } = workspace.services;
    const document = db.documents.create({ title: 'Elsewhere', docType: 'pdf', source: 'zotero' });
    // A real PDF, but at a path no allowed root covers. The extractor must refuse it on the
    // path alone — the same guard the rrfile:// protocol applies, enforced a second time here
    // because a database row is not a trustworthy source of paths.
    const outside = join(workspace.dir, 'outside.pdf');
    writeFileSync(outside, readFileSync(FIXTURE_PDF));
    db.files.upsertByPath({
      documentId: document.id,
      path: outside,
      mimeType: 'application/pdf',
      byteSize: statSync(outside).size,
      contentHash: 'deadbeef',
      role: 'primary',
    });

    // Queued directly rather than through the handler, which kicks a drain it does not await
    // — that kick would race this one for the job and make the counters non-deterministic.
    expect(pipeline.enqueue(document.id)).toBe(true);
    expect(await pipeline.drain()).toEqual({ processed: 1, succeeded: 0, failed: 1 });

    expect(db.jobs.listFailed()[0]?.error ?? '').toContain('outside the allowed roots');
    // Nothing was indexed despite the bytes being perfectly readable.
    expect(db.chunks.listForDocument(document.id)).toEqual([]);
  });

  it('[M09] survives restart with the index intact', async () => {
    const { documentId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);

    workspace.restart();

    const status = await workspace.call('search:status', {});
    expect(status.indexedDocuments).toBe(1);
    const found = await workspace.call('search:query', { query: 'sinusoidal' });
    expect(found.results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// M10 — search results can open the correct PDF page
// ---------------------------------------------------------------------------

describe('search result navigation', () => {
  it('[M10] returns the page location a term actually appears on', async () => {
    const { documentId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);

    const pageText = new Map(
      workspace.services.db.chunks
        .listForDocument(documentId)
        .map((chunk) => [chunk.pageIndex, chunk.text] as const),
    );

    for (const { term, pageIndex } of PAGE_UNIQUE_TERMS) {
      const { results } = await workspace.call('search:query', {
        query: term,
        filters: { entityTypes: ['chunk'] },
      });
      expect(results.length, `no result for "${term}"`).toBeGreaterThan(0);

      const top = results[0];
      expect(top?.documentId).toBe(documentId);
      expect(top?.location?.kind).toBe('pdf');
      const location = top?.location;
      if (location?.kind !== 'pdf') throw new Error('expected a pdf location');

      // The claimed page is the page the term is really on — checked against the extracted
      // text rather than against the same index that produced the answer.
      expect(location.pageIndex).toBe(pageIndex);
      expect(pageText.get(location.pageIndex)?.toLowerCase()).toContain(term);
    }
  });

  it('[M10] opens the file the result points at without exposing a filesystem path', async () => {
    const { documentId, fileId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);

    const { results } = await workspace.call('search:query', {
      query: 'warmup',
      filters: { entityTypes: ['chunk'] },
    });
    const hit = results[0];
    expect(hit?.documentId).toBe(documentId);

    // What the renderer does with a result: open the document's file, then reveal the page.
    // The library projection is how it learns which file that is — by role, never by path.
    const item = await workspace.call('library:getDocument', { documentId });
    const primary = item.item.files.find((file) => file.role === 'primary');
    expect(primary?.id).toBe(fileId);
    expect(primary?.url).toBe(`rrfile://${fileId}`);
    expect(item.item.files.every((file) => !('path' in file))).toBe(true);

    const opened = await workspace.call('document:openFile', { fileId });
    expect(opened.document.id).toBe(documentId);
    expect(opened.file.url).toMatch(/^rrfile:\/\//);
    // The renderer must never receive a path it could use directly.
    expect(JSON.stringify(opened)).not.toContain(FIXTURE_PDF);
    expect(Object.keys(opened.file)).not.toContain('path');

    const location = hit?.location;
    if (location?.kind !== 'pdf') throw new Error('expected a pdf location');
    const outline = await workspace.call('document:getOutline', { documentId });
    expect(outline.outline[location.pageIndex]?.location).toEqual({
      kind: 'pdf',
      pageIndex: location.pageIndex,
    });
  });

  it('[M10] finds an annotation and returns its own page location', async () => {
    const { documentId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);
    const { annotation } = await createHighlight(workspace, documentId, 'label smoothing', 1);

    const { results } = await workspace.call('search:query', {
      query: 'smoothing',
      filters: { entityTypes: ['annotation'] },
    });

    const hit = results.find((result) => result.entityId === annotation.id);
    expect(hit, 'the new highlight is not searchable').toBeDefined();
    expect(hit?.location).toMatchObject({ kind: 'pdf', pageIndex: 1 });
  });
});

// ---------------------------------------------------------------------------
// Highlight helper — used by M10, M12, and M13
// ---------------------------------------------------------------------------

/**
 * Create a highlight the way the reader panel does: take the selected text and the page text
 * it came from, build a text-evidence anchor, and send it over IPC.
 */
async function createHighlight(
  workspace: Workspace,
  documentId: string,
  phrase: string,
  pageIndex: number,
): Promise<{ annotation: AnnotationWithAnchor; anchor: PdfAnchor; pageText: string }> {
  const chunk = workspace.services.db.chunks
    .listForDocument(documentId)
    .find((candidate) => candidate.pageIndex === pageIndex);
  if (chunk === undefined) throw new Error(`page ${String(pageIndex)} is not extracted`);

  const pageText = chunk.text;
  const start = pageText.toLowerCase().indexOf(phrase.toLowerCase());
  if (start < 0) throw new Error(`"${phrase}" does not appear on page ${String(pageIndex)}`);
  const exact = pageText.slice(start, start + phrase.length);

  const file = workspace.services.db.files.primaryForDocument(documentId);
  if (file === null) throw new Error('document has no primary file');

  const selection: PdfReaderSelection = {
    kind: 'pdf',
    pageIndex,
    rects: [{ x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.22 }],
    text: exact,
    pageText,
    position: { start, end: start + exact.length },
  };
  const anchor = createPdfAnchor({ selection, contentHash: file.contentHash });

  const { annotation } = await workspace.call('annotation:create', {
    documentId,
    kind: 'highlight',
    color: 'default',
    selectedText: exact,
    comment: null,
    anchor,
  });

  return { annotation, anchor, pageText };
}

// ---------------------------------------------------------------------------
// M12 — the highlight survives application restart
// ---------------------------------------------------------------------------

describe('highlight persistence', () => {
  it('[M12] the highlight survives application restart and still resolves to its text', async () => {
    const { documentId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);

    const { annotation, pageText } = await createHighlight(
      workspace,
      documentId,
      'scaled dot-product attention',
      0,
    );

    workspace.restart();

    const { annotations } = await workspace.call('annotation:listByDocument', { documentId });
    expect(annotations).toHaveLength(1);

    const restored = annotations[0];
    expect(restored?.id).toBe(annotation.id);
    expect(restored?.selectedText).toBe('scaled dot-product attention');
    expect(restored?.color).toBe('default');
    expect(restored?.kind).toBe('highlight');

    // Persisting the row is not enough — the anchor must still be able to find its text.
    const anchor = restored?.anchor;
    if (anchor?.kind !== 'pdf') throw new Error('expected a pdf anchor');
    expect(anchor.quote.exact).toBe('scaled dot-product attention');
    expect(anchor.pageTextHash.length).toBeGreaterThan(0);

    const resolved = resolvePdfAnchor({ anchor, pageText });
    expect(resolved, 'anchor did not resolve after restart').not.toBeNull();
    expect(resolved?.location).toMatchObject({ kind: 'pdf', pageIndex: 0 });
    expect(resolved?.strategy).toBe('exact-position');
  });

  it('[M12] relocates a restored highlight when the page text has shifted', async () => {
    const { documentId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);
    const { pageText } = await createHighlight(workspace, documentId, 'sinusoidal encodings', 0);

    workspace.restart();

    const { annotations } = await workspace.call('annotation:listByDocument', { documentId });
    const anchor = annotations[0]?.anchor;
    if (anchor?.kind !== 'pdf') throw new Error('expected a pdf anchor');

    // A re-extraction that prepends text moves every offset. Text evidence is what saves the
    // highlight here; stored coordinates alone would point at the wrong span.
    const shifted = `Preprint draft, revised. ${pageText}`;
    const resolved = resolvePdfAnchor({ anchor, pageText: shifted });

    expect(resolved, 'anchor was lost when the page text shifted').not.toBeNull();
    expect(resolved?.strategy).not.toBe('exact-position');
    const location = resolved?.location;
    if (location?.kind !== 'pdf') throw new Error('expected a pdf location');
    const range = location.textRange;
    expect(range).toBeDefined();
    if (range !== undefined) {
      expect(shifted.slice(range.start, range.end)).toBe('sinusoidal encodings');
    }
  });

  it('[M12] a deleted highlight does not come back after restart', async () => {
    const { documentId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);
    const { annotation } = await createHighlight(workspace, documentId, 'Adam optimiser', 1);

    await workspace.call('annotation:delete', { annotationId: annotation.id });
    workspace.restart();

    const { annotations } = await workspace.call('annotation:listByDocument', { documentId });
    expect(annotations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M13 — a note can be attached to the highlight
// ---------------------------------------------------------------------------

describe('notes attached to highlights', () => {
  it('[M13] attaches a note to a highlight and reaches it from either end after restart', async () => {
    const { documentId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);
    const { annotation } = await createHighlight(
      workspace,
      documentId,
      'square root of the key dimension',
      1,
    );

    const { note, links } = await workspace.call('note:create', {
      title: 'Why the rescaling matters',
      contentJson: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Without it the softmax saturates.' }],
          },
        ],
      },
      contentText: 'Without it the softmax saturates.',
      attachToAnnotationId: annotation.id,
    });

    expect(links).toHaveLength(1);
    expect(links[0]?.type).toBe('note-references-annotation');
    expect(links[0]?.targetId).toBe(annotation.id);

    workspace.restart();

    // From the highlight to the note.
    const forDocument = await workspace.call('note:listForAnnotation', {
      annotationId: annotation.id,
    });
    expect(forDocument.notes).toHaveLength(1);
    expect(forDocument.notes[0]?.id).toBe(note.id);
    expect(forDocument.notes[0]?.title).toBe('Why the rescaling matters');

    // From the note back to the highlight — the edge is directed but navigable both ways.
    const references = await workspace.call('link:findReferences', {
      entityType: 'annotation',
      entityId: annotation.id,
    });
    const edge = references.links.find((link) => link.sourceId === note.id);
    expect(edge).toBeDefined();
    expect(edge?.type).toBe('note-references-annotation');

    // The note body itself survived, not merely the edge.
    const reloaded = await workspace.call('note:get', { noteId: note.id });
    expect(reloaded.note.contentText).toBe('Without it the softmax saturates.');
  });

  it('[M13] makes the attached note searchable and traceable to its parent document', async () => {
    const { documentId } = seedDocument(workspace);
    await extractAndIndex(workspace, documentId);
    const { annotation } = await createHighlight(workspace, documentId, 'Label smoothing', 1);

    await workspace.call('note:create', {
      title: 'Regularisation notes',
      contentJson: { type: 'doc', content: [] },
      contentText: 'Smoothing trades calibration for accuracy.',
      attachToAnnotationId: annotation.id,
    });

    workspace.restart();

    const { results } = await workspace.call('search:query', {
      query: 'calibration',
      filters: { entityTypes: ['note'] },
    });
    expect(results.length).toBeGreaterThan(0);

    // The highlight's parent is the document, so a note on it is reachable from the paper.
    const parent = await workspace.call('link:getParent', {
      entityType: 'annotation',
      entityId: annotation.id,
    });
    expect(parent.parent?.entityType).toBe('document');
    expect(parent.parent?.entityId).toBe(documentId);
  });

  it('[M13] refuses to attach a note to an annotation that does not exist', async () => {
    // Well-formed but never minted: this must fail as NOT_FOUND at the handler, not as a
    // schema rejection at the router, or the test would prove nothing about the transaction.
    const result = await dispatch(
      createHandlers(workspace.services),
      'note:create',
      {
        title: 'Orphan',
        contentJson: {},
        contentText: '',
        attachToAnnotationId: mintId('annotation'),
      },
      silentLogger,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');

    // The failed attachment must not have left a stray note behind.
    const { total } = await workspace.call('note:list', {});
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L03, L04 — reference listing over the real link store
//
// The workbench unit tests for these two criteria drive a fake host, so they prove the
// command wiring and nothing about the query. These drive the real router into the real
// `LinkRepository`, and each one contains at least one edge that must *not* come back —
// a listing that returned everything would be as wrong as one that returned nothing, and
// only a negative case can tell the two apart.
// ---------------------------------------------------------------------------

describe('reference listing', () => {
  /** Three papers and a citation graph over them: B -> A, A -> C, and B -> C. */
  function seedCitationGraph(): {
    a: string;
    b: string;
    c: string;
  } {
    const a = seedDocument(workspace, 'Attention Is All You Need').documentId;
    const b = seedDocument(workspace, 'BERT: Pre-training of Deep Bidirectional Transformers')
      .documentId;
    const c = seedDocument(workspace, 'Layer Normalization').documentId;
    return { a, b, c };
  }

  async function cite(sourceId: string, targetId: string): Promise<void> {
    await workspace.call('link:create', {
      type: 'document-cites-document',
      sourceType: 'document',
      sourceId,
      targetType: 'document',
      targetId,
    });
  }

  it('[L03] lists the references to and from an entity, naming the other endpoint', async () => {
    const { a, b, c } = seedCitationGraph();
    await cite(b, a); // incoming to A
    await cite(a, c); // outgoing from A
    await cite(b, c); // touches neither end of A — must not be listed

    workspace.restart();

    const { links } = await workspace.call('link:findReferences', {
      entityType: 'document',
      entityId: a,
    });

    // Two edges, and the *right* two: the B->C citation shares a type and an endpoint type
    // with both of them, so returning it would mean the query is not filtering at all.
    expect(links).toHaveLength(2);

    const incoming = links.find((link) => link.direction === 'incoming');
    const outgoing = links.find((link) => link.direction === 'outgoing');
    expect(incoming).toBeDefined();
    expect(outgoing).toBeDefined();

    // The panel renders `otherTitle`, so the resolution step — not just the row fetch — is
    // what the reader actually sees.
    expect(incoming?.otherTitle).toBe('BERT: Pre-training of Deep Bidirectional Transformers');
    expect(incoming?.sourceId).toBe(b);
    expect(incoming?.broken).toBe(false);
    expect(outgoing?.otherTitle).toBe('Layer Normalization');
    expect(outgoing?.targetId).toBe(c);
    expect(outgoing?.broken).toBe(false);
  });

  it('[L03] narrows to one direction when asked, rather than always listing both', async () => {
    const { a, b, c } = seedCitationGraph();
    await cite(b, a);
    await cite(a, c);

    const inbound = await workspace.call('link:findReferences', {
      entityType: 'document',
      entityId: a,
      direction: 'incoming',
    });
    expect(inbound.links.map((link) => link.otherDocumentId)).toEqual([b]);

    const outbound = await workspace.call('link:findReferences', {
      entityType: 'document',
      entityId: a,
      direction: 'outgoing',
    });
    expect(outbound.links.map((link) => link.otherDocumentId)).toEqual([c]);
  });

  it('[L03] reports an entity with no references as empty, not as an error', async () => {
    const { c } = seedCitationGraph();
    const { links } = await workspace.call('link:findReferences', {
      entityType: 'document',
      entityId: c,
    });
    expect(links).toEqual([]);
  });

  it('[L04] lists every link of one type and excludes the others', async () => {
    const { a, b, c } = seedCitationGraph();
    await cite(b, a);
    await cite(a, c);
    // A different type over the same pair of endpoints. If the type filter is dropped, this
    // is what shows up in the citation list.
    await workspace.call('link:create', {
      type: 'related-to',
      sourceType: 'document',
      sourceId: a,
      targetType: 'document',
      targetId: b,
    });

    workspace.restart();

    const { links } = await workspace.call('link:findByType', {
      type: 'document-cites-document',
    });

    expect(links).toHaveLength(2);
    expect(links.every((link) => link.type === 'document-cites-document')).toBe(true);
    expect(links.map((link) => [link.sourceId, link.targetId]).sort()).toEqual(
      [
        [b, a],
        [a, c],
      ].sort(),
    );

    // And the type that was excluded is genuinely there to be found.
    const related = await workspace.call('link:findByType', { type: 'related-to' });
    expect(related.links).toHaveLength(1);
    expect(related.links[0]?.targetId).toBe(b);
  });

  it('[L04] narrows a type listing by origin, so derived edges can be separated', async () => {
    const { a, b, c } = seedCitationGraph();
    await cite(b, a);
    await workspace.call('link:create', {
      type: 'document-cites-document',
      sourceType: 'document',
      sourceId: a,
      targetType: 'document',
      targetId: c,
      origin: 'derived',
      generator: 'reference-extractor',
    });

    const manual = await workspace.call('link:findByType', {
      type: 'document-cites-document',
      origin: 'manual',
    });
    expect(manual.links).toHaveLength(1);
    expect(manual.links[0]?.sourceId).toBe(b);

    const derived = await workspace.call('link:findByType', {
      type: 'document-cites-document',
      origin: 'derived',
    });
    expect(derived.links).toHaveLength(1);
    expect(derived.links[0]?.generator).toBe('reference-extractor');
  });

  it('[L04] returns nothing for a type no link carries', async () => {
    const { a, b } = seedCitationGraph();
    await cite(a, b);
    const { links } = await workspace.call('link:findByType', { type: 'note-references-note' });
    expect(links).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M14 — the workspace layout survives restart
// ---------------------------------------------------------------------------

describe('workspace layout persistence', () => {
  it('[M14] restores the saved workspace layout after restart', async () => {
    const { documentId, fileId } = seedDocument(workspace);

    // A layout of the shape Dockview actually serialises: a split grid with two groups.
    const layout = {
      grid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { views: ['library'], activeView: 'library', id: '1' }, size: 260 },
            { type: 'leaf', data: { views: ['reader:a'], activeView: 'reader:a', id: '2' }, size: 900 },
          ],
        },
        width: 1160,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: {
        library: { id: 'library', contentComponent: 'library', title: 'Library' },
        'reader:a': { id: 'reader:a', contentComponent: 'pdf', title: 'Attention Mechanisms' },
      },
      activeGroup: '2',
    };
    const panelState = {
      'reader:a': { documentId, fileId, pageIndex: 2 },
    };

    const { saved } = await workspace.call('workspace:saveLayout', {
      name: 'default',
      layout,
      panelState,
    });
    expect(saved).toBe(true);

    workspace.restart();

    const restored = await workspace.call('workspace:loadLayout', { name: 'default' });
    expect(restored.layout).not.toBeNull();
    expect(restored.layout?.name).toBe('default');
    // The layout round-trips byte-for-byte in structure, including the nested grid.
    expect(restored.layout?.layout).toEqual(layout);
    // Panel state is what lets the reopened reader land on the page the user left.
    expect(restored.layout?.panelState).toEqual(panelState);
  });

  it('[M14] keeps named layouts independent and overwrites in place', async () => {
    await workspace.call('workspace:saveLayout', {
      name: 'default',
      layout: { grid: { root: { type: 'leaf', data: { views: ['library'] } } } },
      panelState: {},
    });
    await workspace.call('workspace:saveLayout', {
      name: 'reading',
      layout: { grid: { root: { type: 'leaf', data: { views: ['pdf'] } } } },
      panelState: { pdf: { pageIndex: 7 } },
    });
    // Saving 'default' again must replace it rather than accumulate rows.
    await workspace.call('workspace:saveLayout', {
      name: 'default',
      layout: { grid: { root: { type: 'leaf', data: { views: ['search'] } } } },
      panelState: {},
    });

    workspace.restart();

    const defaultLayout = await workspace.call('workspace:loadLayout', { name: 'default' });
    const readingLayout = await workspace.call('workspace:loadLayout', { name: 'reading' });

    expect(defaultLayout.layout?.layout).toEqual({
      grid: { root: { type: 'leaf', data: { views: ['search'] } } },
    });
    expect(readingLayout.layout?.panelState).toEqual({ pdf: { pageIndex: 7 } });
    expect(workspace.services.db.layouts.listNames().sort()).toEqual(['default', 'reading']);
  });

  it('[M14] reports no layout for a fresh profile rather than inventing one', async () => {
    const restored = await workspace.call('workspace:loadLayout', { name: 'never-saved' });
    expect(restored.layout).toBeNull();
  });
});
