import { afterEach, describe, expect, it } from 'vitest';
import type { WikiReaderDatabase } from '@wr/database';
import { createTempDatabase, type TempDatabase } from '../../database/test/helpers.js';
import { SearchIndexer } from '../src/indexer.js';
import { SNIPPET_CLOSE, SNIPPET_OPEN, SearchService } from '../src/search-service.js';
import type { ExtractedPage } from '../src/chunking.js';

/**
 * Result mapping runs against a real SQLite FTS5 index rather than a stubbed one: the whole
 * point of criterion T08 is that what comes back out of the index is enough to open the right
 * source location, and a stub would assert only that this file's own object literals survive
 * a round trip.
 */
describe('search result location mapping', () => {
  const temps: TempDatabase[] = [];

  afterEach(() => {
    while (temps.length > 0) temps.pop()?.cleanup();
  });

  function fresh(): TempDatabase {
    const temp = createTempDatabase('wr-search');
    temps.push(temp);
    return temp;
  }

  const PAGES: ExtractedPage[] = [
    {
      pageIndex: 0,
      text: 'Positional information enters the model through fixed sinusoidal encodings.',
    },
    {
      pageIndex: 1,
      text: 'The warmup schedule increases the learning rate linearly for four thousand steps.',
    },
    {
      pageIndex: 2,
      text: 'The complete hyperparameter sweep is reproducible from the seed table.',
    },
  ];

  function seedIndexedDocument(
    db: WikiReaderDatabase,
    options: { title?: string; pages?: ExtractedPage[]; tag?: string } = {},
  ) {
    const document = db.documents.create({
      title: options.title ?? 'Attention Mechanisms in Sequence Models',
      docType: 'pdf',
      authors: [{ family: 'Vaswani', given: 'Ashish' }],
      abstract: 'A sequence transduction architecture that dispenses with recurrence.',
      publishedDate: '2017-06-12',
      source: 'zotero',
    });
    const { revision } = db.revisions.createIfChanged({
      documentId: document.id,
      contentHash: `sha256:${document.id}`,
    });
    if (options.tag !== undefined) db.tags.setDocumentTags(document.id, [options.tag]);
    const indexer = new SearchIndexer(db);
    indexer.indexExtractedPdf(document.id, revision.id, options.pages ?? PAGES);
    return { document, revision, indexer };
  }

  it('[T08] maps a chunk hit to the page it was extracted from', () => {
    const { db } = fresh();
    const { document } = seedIndexedDocument(db);

    const response = new SearchService(db).search('sinusoidal');
    const hit = response.results.find((result) => result.entityType === 'chunk');

    expect(hit).toBeDefined();
    expect(hit?.documentId).toBe(document.id);
    expect(hit?.location).toEqual(
      expect.objectContaining({ kind: 'pdf', pageIndex: 0 }),
    );
  });

  it('[T08] distinguishes pages: each discriminating term resolves to its own page', () => {
    const { db } = fresh();
    seedIndexedDocument(db);
    const service = new SearchService(db);

    for (const [term, expectedPage] of [
      ['sinusoidal', 0],
      ['warmup', 1],
      ['hyperparameter', 2],
    ] as const) {
      const hit = service.search(term).results.find((result) => result.entityType === 'chunk');
      expect(hit?.location, `page for "${term}"`).toEqual(
        expect.objectContaining({ kind: 'pdf', pageIndex: expectedPage }),
      );
    }
  });

  it('[T08] carries a character range that addresses the matched text inside the page', () => {
    const { db } = fresh();
    seedIndexedDocument(db);

    const hit = new SearchService(db)
      .search('hyperparameter')
      .results.find((result) => result.entityType === 'chunk');
    const location = hit?.location;

    if (location === undefined || location === null || location.kind !== 'pdf') {
      throw new Error('expected a pdf location');
    }
    const range = location.textRange;
    expect(range).toBeDefined();
    if (range === undefined) throw new Error('expected a text range');

    const pageText = PAGES[2]?.text ?? '';
    expect(pageText.slice(range.start, range.end)).toContain('hyperparameter');
  });

  it('[T08] returns a snippet with the match delimited, plus a plain copy without markers', () => {
    const { db } = fresh();
    seedIndexedDocument(db);

    const hit = new SearchService(db)
      .search('sinusoidal')
      .results.find((result) => result.entityType === 'chunk');

    expect(hit?.snippet).toContain(SNIPPET_OPEN);
    expect(hit?.snippet).toContain(SNIPPET_CLOSE);
    expect(hit?.plainSnippet).not.toContain(SNIPPET_OPEN);
    expect(hit?.plainSnippet).not.toContain(SNIPPET_CLOSE);
    expect(hit?.plainSnippet).toContain('sinusoidal');
  });

  it('[T08] matches a document by its own metadata, with no location to reveal', () => {
    const { db } = fresh();
    const { document } = seedIndexedDocument(db, { tag: 'transformers' });

    const results = new SearchService(db).search('Vaswani').results;
    const hit = results.find((result) => result.entityType === 'document');

    expect(hit?.entityId).toBe(document.id);
    // The document itself has no page: opening it means opening it at the start.
    expect(hit?.location).toBeNull();
  });

  it('[T08] maps an annotation hit to its anchored page', () => {
    const { db } = fresh();
    const { document } = seedIndexedDocument(db);
    const annotation = db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'default',
      selectedText: 'fixed sinusoidal encodings',
      comment: 'this is the positional encoding claim',
      anchor: {
        kind: 'pdf',
        version: 1,
        pageIndex: 0,
        rects: [{ x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.24 }],
        quote: {
          exact: 'fixed sinusoidal encodings',
          prefix: 'model through ',
          suffix: ' rather than',
        },
        position: { start: 47, end: 73 },
        pageTextHash: 'fnv1a64:0123456789abcdef',
        contentHash: 'sha256:deadbeef',
      },
    });
    new SearchIndexer(db).indexAnnotation(annotation.id);

    const hit = new SearchService(db)
      .search('positional encoding claim')
      .results.find((result) => result.entityType === 'annotation');

    expect(hit?.entityId).toBe(annotation.id);
    expect(hit?.documentId).toBe(document.id);
    expect(hit?.location).toEqual(expect.objectContaining({ kind: 'pdf', pageIndex: 0 }));
  });

  it('[T08] maps a note hit to a note location', () => {
    const { db } = fresh();
    const note = db.notes.create({
      title: 'Reading notes on positional encodings',
      contentJson: { type: 'doc', content: [] },
      contentText: 'The sinusoidal choice is about extrapolating to unseen lengths.',
    });
    new SearchIndexer(db).indexNote(note.id);

    const hit = new SearchService(db)
      .search('extrapolating')
      .results.find((result) => result.entityType === 'note');

    expect(hit?.entityId).toBe(note.id);
    expect(hit?.documentId).toBeNull();
    expect(hit?.location).toEqual({ kind: 'note' });
  });

  it('[T08] restricts results to the requested entity types', () => {
    const { db } = fresh();
    seedIndexedDocument(db);

    const response = new SearchService(db).search('sinusoidal', {
      filters: { entityTypes: ['chunk'] },
    });

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.every((result) => result.entityType === 'chunk')).toBe(true);
  });

  it('[T08] restricts results to the requested document', () => {
    const { db } = fresh();
    const first = seedIndexedDocument(db, { title: 'First paper' });
    seedIndexedDocument(db, { title: 'Second paper' });

    const response = new SearchService(db).search('sinusoidal', {
      filters: { documentIds: [first.document.id] },
    });

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.every((result) => result.documentId === first.document.id)).toBe(true);
  });

  it('[T08] restricts results to documents carrying a tag', () => {
    const { db } = fresh();
    const tagged = seedIndexedDocument(db, { title: 'Tagged paper', tag: 'transformers' });
    seedIndexedDocument(db, { title: 'Untagged paper' });

    const response = new SearchService(db).search('sinusoidal', {
      filters: { tags: ['transformers'] },
    });

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.every((result) => result.documentId === tagged.document.id)).toBe(true);
  });

  it('[T08] orders results with the best match first', () => {
    const { db } = fresh();
    seedIndexedDocument(db);

    const scores = new SearchService(db).search('sinusoidal').results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('[T08] reports the total match count independently of the page limit', () => {
    const { db } = fresh();
    for (let index = 0; index < 4; index += 1) {
      seedIndexedDocument(db, { title: `Paper ${String(index)}` });
    }

    const response = new SearchService(db).search('sinusoidal', { limit: 2 });
    expect(response.results).toHaveLength(2);
    expect(response.total).toBeGreaterThan(2);
  });

  it('[T08] pages through results without repeating one', () => {
    const { db } = fresh();
    for (let index = 0; index < 4; index += 1) {
      seedIndexedDocument(db, { title: `Paper ${String(index)}` });
    }
    const service = new SearchService(db);

    const first = service.search('sinusoidal', { limit: 2, offset: 0 }).results;
    const second = service.search('sinusoidal', { limit: 2, offset: 2 }).results;
    const ids = [...first, ...second].map((result) => result.entityId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('[T08] returns nothing for an empty query rather than everything', () => {
    const { db } = fresh();
    seedIndexedDocument(db);

    const response = new SearchService(db).search('   ');
    expect(response.results).toEqual([]);
    expect(response.total).toBe(0);
  });

  it('[T08] survives query text made entirely of FTS5 operators', () => {
    const { db } = fresh();
    seedIndexedDocument(db);
    const service = new SearchService(db);

    // Each of these would be an FTS5 syntax error if it reached MATCH unquoted.
    for (const input of ['"', '*', '(', 'NEAR/', 'a AND', '^ OR ^']) {
      expect(() => service.search(input), `query ${JSON.stringify(input)}`).not.toThrow();
    }
  });

  it('[T08] finds a hit after re-indexing, without duplicating it', () => {
    const { db } = fresh();
    const { document, revision, indexer } = seedIndexedDocument(db);

    indexer.indexExtractedPdf(document.id, revision.id, PAGES);
    const response = new SearchService(db).search('sinusoidal', {
      filters: { entityTypes: ['chunk'] },
    });

    expect(response.total).toBe(1);
  });
});
