import { afterEach, describe, expect, it } from 'vitest';
import type { WikiReaderDatabase } from '../src/index.js';
import { createTempDatabase, samplePdfAnchor, type TempDatabase } from './helpers.js';

describe('repositories', () => {
  const temps: TempDatabase[] = [];

  afterEach(() => {
    while (temps.length > 0) temps.pop()?.cleanup();
  });

  function fresh(): TempDatabase {
    const temp = createTempDatabase('wr-repos');
    temps.push(temp);
    return temp;
  }

  function seedDocument(db: WikiReaderDatabase, title = 'Attention Is All You Need') {
    const document = db.documents.create({
      title,
      docType: 'pdf',
      authors: [{ family: 'Vaswani', given: 'Ashish' }],
      abstract: 'The dominant sequence transduction models are based on recurrent networks.',
      publishedDate: '2017-06-12',
      source: 'zotero',
    });
    const { revision } = db.revisions.createIfChanged({
      documentId: document.id,
      contentHash: 'sha256:1111',
    });
    const { file } = db.files.upsertByPath({
      documentId: document.id,
      revisionId: revision.id,
      path: `/tmp/zotero/${document.id}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 2048,
      contentHash: 'sha256:1111',
      role: 'primary',
    });
    return { document, revision, file };
  }

  // -------------------------------------------------------------------------
  // Documents, revisions, files, chunks
  // -------------------------------------------------------------------------

  it('creates and reads a document with its authors', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const loaded = db.documents.getById(document.id);
    expect(loaded?.title).toBe('Attention Is All You Need');
    expect(loaded?.authors).toEqual([{ family: 'Vaswani', given: 'Ashish' }]);
    expect(loaded?.deletedAt).toBeNull();
  });

  it('updates only the fields it is given', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const updated = db.documents.update(document.id, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
    expect(updated.abstract).toBe(document.abstract);
    expect(updated.updatedAt > document.updatedAt).toBe(true);
  });

  it('hides soft-deleted documents from the default listing', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    seedDocument(db, 'Second Paper');
    expect(db.documents.list().total).toBe(2);

    expect(db.documents.softDelete(document.id)).toBe(true);
    expect(db.documents.list().total).toBe(1);
    expect(db.documents.list({ includeDeleted: true }).total).toBe(2);
    // Deleting twice is not an error, but reports that nothing changed.
    expect(db.documents.softDelete(document.id)).toBe(false);
  });

  it('filters the document list by collection, tag and title', () => {
    const { db } = fresh();
    const { document: first } = seedDocument(db, 'Transformer Networks');
    const { document: second } = seedDocument(db, 'Graph Kernels');
    const collection = db.collections.create({ name: 'NLP' });
    db.collections.setDocumentCollections(first.id, [collection.id]);
    db.tags.setDocumentTags(second.id, ['graphs']);

    expect(db.documents.list({ collectionId: collection.id }).items.map((d) => d.id)).toEqual([
      first.id,
    ]);
    expect(db.documents.list({ tag: 'graphs' }).items.map((d) => d.id)).toEqual([second.id]);
    expect(db.documents.list({ query: 'transformer' }).items.map((d) => d.id)).toEqual([first.id]);
    expect(db.documents.list({ query: 'nothing here' }).items).toEqual([]);
  });

  it('treats LIKE wildcards in a title query as literal characters', () => {
    const { db } = fresh();
    seedDocument(db, 'Ordinary title');
    expect(db.documents.list({ query: '%' }).items).toEqual([]);
  });

  it('reuses the existing revision when the content hash is unchanged', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const again = db.revisions.createIfChanged({
      documentId: document.id,
      contentHash: 'sha256:1111',
    });
    expect(again.created).toBe(false);
    expect(db.revisions.listForDocument(document.id)).toHaveLength(1);

    const changed = db.revisions.createIfChanged({
      documentId: document.id,
      contentHash: 'sha256:2222',
    });
    expect(changed.created).toBe(true);
    expect(changed.revision.revisionNo).toBe(2);
    expect(db.revisions.latestForDocument(document.id)?.id).toBe(changed.revision.id);
  });

  it('keeps one file row per path across repeated imports', () => {
    const { db } = fresh();
    const { document, file } = seedDocument(db);
    const second = db.files.upsertByPath({
      documentId: document.id,
      path: file.path,
      mimeType: 'application/pdf',
      byteSize: 4096,
      contentHash: 'sha256:3333',
      role: 'primary',
    });
    expect(second.created).toBe(false);
    expect(second.file.id).toBe(file.id);
    expect(second.file.byteSize).toBe(4096);
    expect(db.files.listByDocument(document.id)).toHaveLength(1);
  });

  it('projects a file to a renderer-safe reference without its path', () => {
    const { db } = fresh();
    const { document, file } = seedDocument(db);
    const item = db.library.get(document.id);
    const ref = item?.files[0];
    expect(ref?.url).toBe(`rrfile://${file.id}`);
    expect(Object.keys(ref ?? {})).not.toContain('path');
    expect(JSON.stringify(ref)).not.toContain('/tmp/zotero');
  });

  it('replaces chunks wholesale when a revision is re-extracted', () => {
    const { db } = fresh();
    const { document, revision } = seedDocument(db);
    db.chunks.replaceForRevision(document.id, revision.id, [
      { chunkIndex: 0, kind: 'pdf-page', pageIndex: 0, charStart: 0, charEnd: 5, text: 'first' },
      { chunkIndex: 1, kind: 'pdf-page', pageIndex: 1, charStart: 5, charEnd: 11, text: 'second' },
    ]);
    expect(db.chunks.countForDocument(document.id)).toBe(2);

    db.chunks.replaceForRevision(document.id, revision.id, [
      { chunkIndex: 0, kind: 'pdf-page', pageIndex: 0, charStart: 0, charEnd: 7, text: 'rewrite' },
    ]);
    const chunks = db.chunks.listForRevision(revision.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('rewrite');
  });

  // -------------------------------------------------------------------------
  // Annotations and notes
  // -------------------------------------------------------------------------

  it('stores an annotation together with its anchoring evidence', () => {
    const { db } = fresh();
    const { document, revision } = seedDocument(db);
    const annotation = db.annotations.create({
      documentId: document.id,
      revisionId: revision.id,
      kind: 'highlight',
      color: 'default',
      selectedText: 'attention is all you need',
      comment: null,
      anchor: samplePdfAnchor(),
    });

    expect(annotation.anchor.kind).toBe('pdf');
    expect(annotation.anchorId.startsWith('anc_')).toBe(true);
    const anchor = db.annotations.anchorOf(annotation.id);
    expect(anchor?.kind === 'pdf' ? anchor.pageIndex : -1).toBe(2);
    // The quote and hashes are what let the highlight be relocated later.
    expect(anchor?.quote.exact).toBe('attention is all you need');
    expect(db.annotations.listByDocument(document.id)).toHaveLength(1);
  });

  it('derives the annotation-belongs-to-document edge when an annotation is created', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const annotation = db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'default',
      selectedText: 'sequence transduction',
      anchor: samplePdfAnchor({ exact: 'sequence transduction' }),
    });

    const links = db.links.findReferences({
      entityType: 'annotation',
      entityId: annotation.id,
      direction: 'outgoing',
    });
    const belongsTo = links.find((link) => link.type === 'annotation-belongs-to-document');
    expect(belongsTo?.targetId).toBe(document.id);
    expect(belongsTo?.origin).toBe('derived');
  });

  it('hides soft-deleted annotations but keeps their rows', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const annotation = db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'default',
      selectedText: 'recurrent networks',
      anchor: samplePdfAnchor({ exact: 'recurrent networks' }),
    });
    expect(db.annotations.softDelete(annotation.id)).toBe(true);
    expect(db.annotations.listByDocument(document.id)).toEqual([]);
    expect(db.annotations.listByDocument(document.id, true)).toHaveLength(1);
    expect(db.annotations.countForDocument(document.id)).toBe(0);
  });

  it('finds the notes attached to an annotation', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const annotation = db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'default',
      selectedText: 'positional encoding',
      anchor: samplePdfAnchor({ exact: 'positional encoding' }),
    });
    const note = db.notes.create({
      title: 'On positional encodings',
      contentJson: { type: 'doc', content: [] },
      contentText: 'sinusoidal vs learned',
    });
    db.links.create({
      type: 'note-references-annotation',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'annotation',
      targetId: annotation.id,
    });

    expect(db.notes.listForAnnotation(annotation.id).map((n) => n.id)).toEqual([note.id]);
    expect(db.notes.listForAnnotation(document.id)).toEqual([]);
  });

  it('round-trips Tiptap JSON through the note store', () => {
    const { db } = fresh();
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    };
    const note = db.notes.create({ title: 'A note', contentJson: content, contentText: 'hello' });
    expect(db.notes.get(note.id)?.contentJson).toEqual(content);

    const updated = db.notes.update(note.id, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
    expect(updated.contentJson).toEqual(content);
  });

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  it('treats the same edge created twice as one fact', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const note = db.notes.create({ title: 'n', contentJson: {}, contentText: '' });
    const first = db.links.create({
      type: 'note-references-document',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'document',
      targetId: document.id,
    });
    const second = db.links.create({
      type: 'note-references-document',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'document',
      targetId: document.id,
    });
    expect(second.id).toBe(first.id);
    expect(db.links.counts('document', document.id).incoming).toBe(1);
  });

  it('separates incoming from outgoing references', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const a = db.notes.create({ title: 'a', contentJson: {}, contentText: '' });
    const b = db.notes.create({ title: 'b', contentJson: {}, contentText: '' });
    db.links.create({
      type: 'note-references-document',
      sourceType: 'note',
      sourceId: a.id,
      targetType: 'document',
      targetId: document.id,
    });
    db.links.create({
      type: 'note-references-note',
      sourceType: 'note',
      sourceId: a.id,
      targetType: 'note',
      targetId: b.id,
    });

    const outgoing = db.links.findReferences({
      entityType: 'note',
      entityId: a.id,
      direction: 'outgoing',
    });
    expect(outgoing).toHaveLength(2);
    expect(outgoing.every((link) => link.direction === 'outgoing')).toBe(true);

    const incoming = db.links.findReferences({
      entityType: 'note',
      entityId: b.id,
      direction: 'incoming',
    });
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.otherTitle).toBe('a');
    expect(incoming[0]?.direction).toBe('incoming');

    expect(db.links.findReferences({ entityType: 'note', entityId: a.id })).toHaveLength(2);
  });

  /**
   * The default cap is a list's end, not an answer. A caller that has to be exhaustive —
   * the desk migration, which then records itself done — asks for `limit: null` and gets
   * every row. Nothing on the IPC bridge can: the channel's schema bounds it at 2000.
   */
  it('[L03] answers with every reference when the caller asks for no limit', () => {
    const { db } = fresh();
    const note = db.notes.create({ title: 'busy', contentJson: {}, contentText: '' });
    for (let index = 0; index < 620; index += 1) {
      const other = db.notes.create({
        title: `other ${String(index)}`,
        contentJson: {},
        contentText: '',
      });
      db.links.create({
        type: 'note-references-note',
        sourceType: 'note',
        sourceId: note.id,
        targetType: 'note',
        targetId: other.id,
      });
    }

    const capped = db.links.findReferences({ entityType: 'note', entityId: note.id });
    expect(capped).toHaveLength(500);

    const all = db.links.findReferences({
      entityType: 'note',
      entityId: note.id,
      limit: null,
    });
    expect(all).toHaveLength(620);
    expect(new Set(all.map((link) => link.id)).size).toBe(620);
  });

  it('marks a reference as broken when its other endpoint no longer resolves', () => {
    const { db } = fresh();
    const note = db.notes.create({ title: 'orphan', contentJson: {}, contentText: '' });
    db.links.create({
      type: 'note-references-note',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'note',
      targetId: 'not_00000000000000000000000000',
    });
    const [link] = db.links.findReferences({ entityType: 'note', entityId: note.id });
    expect(link?.broken).toBe(true);
    expect(link?.otherTitle).toBe('');
  });

  it('narrows links of one type by document, origin and creation time', () => {
    const { db } = fresh();
    const { document: first } = seedDocument(db, 'First');
    const { document: second } = seedDocument(db, 'Second');
    const note = db.notes.create({ title: 'n', contentJson: {}, contentText: '' });

    db.links.create({
      type: 'note-references-document',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'document',
      targetId: first.id,
      origin: 'manual',
    });
    const derived = db.links.create({
      type: 'note-references-document',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'document',
      targetId: second.id,
      origin: 'derived',
      generator: 'citation-parser',
    });

    expect(db.links.findByType({ type: 'note-references-document' })).toHaveLength(2);
    expect(
      db.links.findByType({ type: 'note-references-document', documentId: first.id }),
    ).toHaveLength(1);
    expect(
      db.links.findByType({ type: 'note-references-document', origin: 'derived' })[0]?.id,
    ).toBe(derived.id);
    expect(
      db.links.findByType({ type: 'note-references-document', generator: 'citation-parser' }),
    ).toHaveLength(1);
    expect(
      db.links.findByType({
        type: 'note-references-document',
        createdAfter: '2030-01-01T00:00:00.000Z',
      }),
    ).toEqual([]);
    expect(db.links.findByType({ type: 'no-such-type' })).toEqual([]);
  });

  it('narrows links of one type by collection and tag through their documents', () => {
    const { db } = fresh();
    const { document: inScope } = seedDocument(db, 'In scope');
    const { document: outOfScope } = seedDocument(db, 'Out of scope');
    const collection = db.collections.create({ name: 'Reading list' });
    db.collections.setDocumentCollections(inScope.id, [collection.id]);
    db.tags.setDocumentTags(inScope.id, ['to-read']);

    const annotation = db.annotations.create({
      documentId: inScope.id,
      kind: 'highlight',
      color: 'tan',
      selectedText: 'scoped highlight',
      anchor: samplePdfAnchor({ exact: 'scoped highlight' }),
    });
    db.annotations.create({
      documentId: outOfScope.id,
      kind: 'highlight',
      color: 'tan',
      selectedText: 'other highlight',
      anchor: samplePdfAnchor({ exact: 'other highlight' }),
    });

    const byCollection = db.links.findByType({
      type: 'annotation-belongs-to-document',
      collectionId: collection.id,
    });
    expect(byCollection.map((link) => link.sourceId)).toEqual([annotation.id]);

    const byTag = db.links.findByType({ type: 'annotation-belongs-to-document', tag: 'to-read' });
    expect(byTag.map((link) => link.sourceId)).toEqual([annotation.id]);

    expect(
      db.links.findByType({ type: 'annotation-belongs-to-document', tag: 'unused-tag' }),
    ).toEqual([]);
  });

  it('deletes every edge touching an entity on request', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const note = db.notes.create({ title: 'n', contentJson: {}, contentText: '' });
    db.links.create({
      type: 'note-references-document',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'document',
      targetId: document.id,
    });
    expect(db.links.deleteForEntity('note', note.id)).toBe(1);
    expect(db.links.findReferences({ entityType: 'document', entityId: document.id })).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Entity resolution and parents
  // -------------------------------------------------------------------------

  it('resolves an annotation to its parent document at the highlight location', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const annotation = db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'tan',
      selectedText: 'multi-head attention',
      anchor: samplePdfAnchor({ pageIndex: 4, exact: 'multi-head attention' }),
    });

    const parent = db.entities.parentOf('annotation', annotation.id);
    expect(parent?.entityType).toBe('document');
    expect(parent?.entityId).toBe(document.id);
    expect(parent?.location).toEqual(expect.objectContaining({ kind: 'pdf', pageIndex: 4 }));
  });

  it('resolves a document to the collection containing it', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const collection = db.collections.create({ name: 'Transformers' });
    db.collections.setDocumentCollections(document.id, [collection.id]);

    const parent = db.entities.parentOf('document', document.id);
    expect(parent?.entityType).toBe('collection');
    expect(parent?.title).toBe('Transformers');
  });

  it('prefers an explicit child-of edge over implied containment', () => {
    const { db } = fresh();
    const parentNote = db.notes.create({ title: 'parent', contentJson: {}, contentText: '' });
    const childNote = db.notes.create({ title: 'child', contentJson: {}, contentText: '' });
    db.links.create({
      type: 'child-of',
      sourceType: 'note',
      sourceId: childNote.id,
      targetType: 'note',
      targetId: parentNote.id,
    });
    expect(db.entities.parentOf('note', childNote.id)?.entityId).toBe(parentNote.id);
  });

  it('resolves an excerpt to the annotation it was derived from', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const annotation = db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'tan',
      selectedText: 'scaled dot-product',
      anchor: samplePdfAnchor({ exact: 'scaled dot-product' }),
    });
    const excerptId = 'excerpt-node-1';
    db.links.create({
      type: 'excerpt-derived-from-annotation',
      sourceType: 'excerpt',
      sourceId: excerptId,
      targetType: 'annotation',
      targetId: annotation.id,
    });
    const parent = db.entities.parentOf('excerpt', excerptId);
    expect(parent?.entityType).toBe('annotation');
    expect(parent?.entityId).toBe(annotation.id);
  });

  it('resolves a chunk to a location that names its page', () => {
    const { db } = fresh();
    const { document, revision } = seedDocument(db);
    const [chunk] = db.chunks.replaceForRevision(document.id, revision.id, [
      { chunkIndex: 0, kind: 'pdf-page', pageIndex: 7, charStart: 0, charEnd: 4, text: 'body' },
    ]);
    const described = db.entities.describe('chunk', chunk?.id ?? '');
    expect(described?.location).toEqual({ kind: 'pdf', pageIndex: 7 });
    expect(described?.documentId).toBe(document.id);
  });

  // -------------------------------------------------------------------------
  // Organisation, session state, provenance, jobs
  // -------------------------------------------------------------------------

  it('creates each tag once no matter how many documents use it', () => {
    const { db } = fresh();
    const { document: first } = seedDocument(db, 'One');
    const { document: second } = seedDocument(db, 'Two');
    db.tags.setDocumentTags(first.id, ['nlp', 'transformers']);
    db.tags.setDocumentTags(second.id, ['nlp']);
    expect(db.tags.list().map((tag) => tag.name)).toEqual(['nlp', 'transformers']);
    expect(db.tags.namesForDocument(first.id)).toEqual(['nlp', 'transformers']);

    db.tags.setDocumentTags(first.id, ['nlp']);
    expect(db.tags.namesForDocument(first.id)).toEqual(['nlp']);
  });

  it('replaces collection membership rather than accumulating it', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const a = db.collections.create({ name: 'A' });
    const b = db.collections.create({ name: 'B' });
    db.collections.setDocumentCollections(document.id, [a.id, b.id]);
    expect(db.collections.collectionIdsForDocument(document.id)).toHaveLength(2);
    db.collections.setDocumentCollections(document.id, [b.id]);
    expect(db.collections.collectionIdsForDocument(document.id)).toEqual([b.id]);
    expect(db.collections.documentCount(a.id)).toBe(0);
  });

  it('maps a provider key to one internal entity across repeated imports', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const first = db.externalReferences.upsert({
      entityType: 'document',
      entityId: document.id,
      provider: 'zotero',
      externalKey: 'ABCD1234',
      externalVersion: 7,
    });
    const second = db.externalReferences.upsert({
      entityType: 'document',
      entityId: document.id,
      provider: 'zotero',
      externalKey: 'ABCD1234',
      externalVersion: 9,
    });
    expect(second.id).toBe(first.id);
    expect(second.externalVersion).toBe(9);
    expect(db.externalReferences.resolveEntityId('zotero', 'document', 'ABCD1234')).toBe(
      document.id,
    );
    expect(db.externalReferences.resolveEntityId('zotero', 'document', 'UNKNOWN')).toBeNull();
  });

  it('keeps at most one outstanding indexing job per document and type', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    const first = db.jobs.enqueue(document.id, 'extract-text');
    const second = db.jobs.enqueue(document.id, 'extract-text');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(db.jobs.enqueue(document.id, 'index-fts').created).toBe(true);
  });

  it('claims, completes and fails indexing jobs without losing the error', () => {
    const { db } = fresh();
    const { document } = seedDocument(db);
    db.jobs.enqueue(document.id, 'extract-text');
    const claimed = db.jobs.claimNext('extract-text');
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(db.jobs.claimNext('extract-text')).toBeNull();

    db.jobs.fail(claimed?.id ?? '', 'pdfjs: password required');
    const failed = db.jobs.listFailed();
    expect(failed[0]?.error).toBe('pdfjs: password required');
    expect(db.jobs.counts().failed).toBe(1);

    expect(db.jobs.requeue(failed[0]?.id ?? '')).toBe(true);
    const retried = db.jobs.claimNext();
    expect(retried?.attempts).toBe(2);
    db.jobs.complete(retried?.id ?? '');
    expect(db.jobs.counts()).toMatchObject({ queued: 0, running: 0, complete: 1, failed: 0 });
  });

  it('composes a library item from its document, files, tags and counts', () => {
    const { db } = fresh();
    const { document, revision } = seedDocument(db);
    db.tags.setDocumentTags(document.id, ['nlp']);
    const collection = db.collections.create({ name: 'Papers' });
    db.collections.setDocumentCollections(document.id, [collection.id]);
    db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'tan',
      selectedText: 'encoder stack',
      anchor: samplePdfAnchor({ exact: 'encoder stack' }),
    });

    const before = db.library.get(document.id);
    expect(before?.tags).toEqual(['nlp']);
    expect(before?.collectionIds).toEqual([collection.id]);
    expect(before?.annotationCount).toBe(1);
    expect(before?.hasExtractedText).toBe(false);

    db.chunks.replaceForRevision(document.id, revision.id, [
      { chunkIndex: 0, kind: 'pdf-page', pageIndex: 0, charStart: 0, charEnd: 4, text: 'text' },
    ]);
    expect(db.library.get(document.id)?.hasExtractedText).toBe(true);
    expect(db.library.list().items).toHaveLength(1);
  });

  it('runs a transaction atomically', () => {
    const { db } = fresh();
    expect(() =>
      db.transaction(() => {
        db.documents.create({ title: 'Committed?', docType: 'pdf', source: 'test' });
        throw new Error('rollback please');
      }),
    ).toThrow('rollback please');
    expect(db.documents.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Persistence across a restart
  // -------------------------------------------------------------------------

  it('[L10] persists typed links and their navigation targets across a restart', () => {
    const temp = fresh();
    const { document, revision } = seedDocument(temp.db);
    const annotation = temp.db.annotations.create({
      documentId: document.id,
      revisionId: revision.id,
      kind: 'highlight',
      color: 'default',
      selectedText: 'multi-head attention',
      comment: 'compare with additive attention',
      anchor: samplePdfAnchor({ pageIndex: 3, exact: 'multi-head attention' }),
    });
    const note = temp.db.notes.create({
      title: 'Attention variants',
      contentJson: { type: 'doc', content: [] },
      contentText: 'additive vs dot-product',
    });
    const link = temp.db.links.create({
      type: 'note-references-annotation',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'annotation',
      targetId: annotation.id,
      // A navigation target: where the reader should reveal the endpoint.
      targetLocation: { kind: 'pdf', pageIndex: 3, pageOffsetRatio: 0.42 },
      sourceLocation: { kind: 'note', blockIndex: 2 },
      label: 'discussed here',
      metadata: { createdBy: 'test' },
    });

    const reopened = temp.reopen();

    const restored = reopened.links.getById(link.id);
    expect(restored?.type).toBe('note-references-annotation');
    expect(restored?.label).toBe('discussed here');
    expect(restored?.metadata).toEqual({ createdBy: 'test' });
    expect(restored?.targetLocation).toEqual({
      kind: 'pdf',
      pageIndex: 3,
      pageOffsetRatio: 0.42,
    });
    expect(restored?.sourceLocation).toEqual({ kind: 'note', blockIndex: 2 });

    const references = reopened.links.findReferences({
      entityType: 'annotation',
      entityId: annotation.id,
      direction: 'incoming',
    });
    expect(references.map((r) => r.sourceId)).toContain(note.id);
    expect(references[0]?.otherTitle).toBe('Attention variants');
    expect(references[0]?.broken).toBe(false);
  });

  it('[L10] persists navigation targets recorded on annotations and reading positions', () => {
    const temp = fresh();
    const { document } = seedDocument(temp.db);
    const annotation = temp.db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'default',
      selectedText: 'positional encodings',
      anchor: samplePdfAnchor({ pageIndex: 5, exact: 'positional encodings' }),
    });
    temp.db.readingPositions.set(document.id, {
      kind: 'pdf',
      pageIndex: 5,
      pageOffsetRatio: 0.75,
    });
    temp.db.layouts.save(
      'default',
      { grid: { root: { type: 'branch' } } },
      { 'panel-1': { documentId: document.id, pageIndex: 5 } },
    );

    const reopened = temp.reopen();

    expect(reopened.readingPositions.get(document.id)?.location).toEqual({
      kind: 'pdf',
      pageIndex: 5,
      pageOffsetRatio: 0.75,
    });
    const layout = reopened.layouts.load('default');
    expect(layout?.layout).toEqual({ grid: { root: { type: 'branch' } } });
    expect(layout?.panelState).toEqual({ 'panel-1': { documentId: document.id, pageIndex: 5 } });

    const target = reopened.entities.describe('annotation', annotation.id);
    expect(target?.location).toEqual(
      expect.objectContaining({ kind: 'pdf', pageIndex: 5 }),
    );
    expect(target?.documentId).toBe(document.id);
  });
});
