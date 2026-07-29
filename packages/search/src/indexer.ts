/**
 * Projection of documents, chunks, annotations and notes into the FTS5 index.
 *
 * The index is a *projection*, never a source of truth: it can be dropped and rebuilt from
 * the tables at any time. That is what makes re-extraction safe — a document's chunk entries
 * are removed and rewritten as a unit rather than accumulating stale rows from an earlier
 * revision.
 *
 * Every indexed row carries the location needed to reveal it, so a hit never has to be
 * re-resolved against the source file at query time.
 */
import type {
  Author,
  DocumentChunk,
  DocumentLocation,
  ExtractedChunk,
} from '@wr/shared-types';
import { anchorToLocation, chunkToLocation } from '@wr/document-model';
import type { SearchEntryInput, WikiReaderDatabase } from '@wr/database';
import { chunkPdfPages, type ChunkOptions, type ExtractedPage } from './chunking.js';

export interface IndexLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

const silentLogger: IndexLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export interface IndexDocumentResult {
  readonly documentId: string;
  readonly revisionId: string;
  readonly chunkCount: number;
  readonly entryCount: number;
}

/**
 * Where a chunk hit should open.
 *
 * `chunkToLocation` gives the page or section; the character range is added on top so the
 * reader can reveal the matching passage rather than only the top of the page.
 */
/**
 * Author as one searchable string. `literal` wins when present — it is the form used for
 * corporate authors, where splitting into given/family would be wrong.
 */
function formatAuthor(author: Author): string {
  if (author.literal !== undefined && author.literal.trim().length > 0) return author.literal;
  return author.given === undefined ? author.family : `${author.given} ${author.family}`;
}

export function locationForChunk(chunk: DocumentChunk): DocumentLocation {
  const base = chunkToLocation(chunk);
  if (base.kind === 'note') return base;
  return { ...base, textRange: { start: chunk.charStart, end: chunk.charEnd } };
}

export class SearchIndexer {
  constructor(
    private readonly db: WikiReaderDatabase,
    private readonly logger: IndexLogger = silentLogger,
  ) {}

  /**
   * Store extracted PDF pages as chunks and index them (criterion M09).
   *
   * Chunk rows and index entries are written in one transaction: a crash between the two
   * would otherwise leave text that is stored but unfindable, which stays invisible until a
   * user notices a document missing from results.
   */
  indexExtractedPdf(
    documentId: string,
    revisionId: string,
    pages: readonly ExtractedPage[],
    options: ChunkOptions = {},
  ): IndexDocumentResult {
    const chunkInputs = chunkPdfPages(pages, options);

    const result = this.db.sqlite.transaction((): IndexDocumentResult => {
      const chunks = this.db.chunks.replaceForRevision(documentId, revisionId, chunkInputs);
      this.db.searchIndex.removeChunksForDocument(documentId);
      const entries = chunks.map((chunk) => this.chunkEntry(documentId, chunk));
      const written = this.db.searchIndex.upsertMany(entries);
      this.indexDocumentRecord(documentId);
      return { documentId, revisionId, chunkCount: chunks.length, entryCount: written };
    })();

    this.logger.info('indexed extracted pdf', {
      documentId,
      revisionId,
      pages: pages.length,
      chunks: result.chunkCount,
    });
    return result;
  }

  /**
   * Store an already-chunked document (markdown sections, and later HTML sections).
   *
   * The PDF path derives its chunks from page text here; a markdown document arrives already
   * divided by its own headings, because the section boundary is part of the source rather
   * than something the indexer has to guess. Everything after that is identical, so the
   * transaction and the entry projection are shared.
   */
  indexExtractedChunks(
    documentId: string,
    revisionId: string,
    chunks: readonly ExtractedChunk[],
  ): IndexDocumentResult {
    const chunkInputs = chunks.map((chunk) => ({
      chunkIndex: chunk.index,
      kind: chunk.kind,
      pageIndex: chunk.pageIndex ?? null,
      sectionPath: chunk.sectionPath ?? null,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      text: chunk.text,
    }));

    const result = this.db.sqlite.transaction((): IndexDocumentResult => {
      const stored = this.db.chunks.replaceForRevision(documentId, revisionId, chunkInputs);
      this.db.searchIndex.removeChunksForDocument(documentId);
      const entries = stored.map((chunk) => this.chunkEntry(documentId, chunk));
      const written = this.db.searchIndex.upsertMany(entries);
      this.indexDocumentRecord(documentId);
      return { documentId, revisionId, chunkCount: stored.length, entryCount: written };
    })();

    this.logger.info('indexed extracted chunks', {
      documentId,
      revisionId,
      chunks: result.chunkCount,
    });
    return result;
  }

  private chunkEntry(documentId: string, chunk: DocumentChunk): SearchEntryInput {
    return {
      entityType: 'chunk',
      entityId: chunk.id,
      documentId,
      location: locationForChunk(chunk),
      title: chunk.pageIndex === null ? '' : `p. ${String(chunk.pageIndex + 1)}`,
      body: chunk.text,
    };
  }

  /** Index the document's own metadata so a title or author match finds it directly. */
  indexDocumentRecord(documentId: string): boolean {
    const document = this.db.documents.getById(documentId);
    if (document === null) {
      this.logger.warn('cannot index unknown document', { documentId });
      return false;
    }

    const tags = this.db.tags.namesForDocument(documentId);
    const collections = this.db.collections
      .collectionIdsForDocument(documentId)
      .map((id) => this.db.collections.getById(id)?.name ?? '')
      .filter((name) => name.length > 0);
    const authors = document.authors.map(formatAuthor);

    this.db.searchIndex.upsert({
      entityType: 'document',
      entityId: document.id,
      documentId: document.id,
      location: null,
      title: document.title,
      body: document.abstract ?? '',
      meta: [...authors, ...tags, ...collections].join(' • '),
    });
    return true;
  }

  indexAnnotation(annotationId: string): boolean {
    const annotation = this.db.annotations.get(annotationId);
    if (annotation === null) {
      this.logger.warn('cannot index unknown annotation', { annotationId });
      return false;
    }

    this.db.searchIndex.upsert({
      entityType: 'annotation',
      entityId: annotation.id,
      documentId: annotation.documentId,
      location: anchorToLocation(annotation.anchor),
      title: annotation.selectedText.slice(0, 120),
      body: [annotation.selectedText, annotation.comment ?? ''].join('\n').trim(),
    });
    return true;
  }

  indexNote(noteId: string): boolean {
    const note = this.db.notes.get(noteId);
    if (note === null) {
      this.logger.warn('cannot index unknown note', { noteId });
      return false;
    }

    this.db.searchIndex.upsert({
      entityType: 'note',
      entityId: note.id,
      documentId: null,
      location: { kind: 'note' },
      title: note.title,
      body: note.contentText,
    });
    return true;
  }

  /**
   * Rebuild every entry a document should have, from what the database already holds.
   *
   * This is the other half of `LibraryRepository.remove`, which drops a removed document's
   * entries so that nothing the library says is gone can still answer a query. The chunks and
   * the annotations themselves survive a removal — they are the researcher's work — so putting
   * the document back is a re-projection of rows that never left, and reads no file. That is
   * what lets a restored document of any type answer searches again, rather than only a PDF
   * that happens to be re-extracted afterwards.
   *
   * Annotations are included because `removeForDocument` took them too: a highlight that
   * stopped being findable when its paper left the library, and stayed unfindable after the
   * paper came back, is work the researcher can no longer reach by searching for it.
   */
  reindexDocument(documentId: string): number {
    const written = this.db.sqlite.transaction((): number => {
      if (!this.indexDocumentRecord(documentId)) return 0;
      let entries = 1;

      this.db.searchIndex.removeChunksForDocument(documentId);
      const chunks = this.db.chunks.listForDocument(documentId);
      entries += this.db.searchIndex.upsertMany(
        chunks.map((chunk) => this.chunkEntry(documentId, chunk)),
      );

      for (const annotation of this.db.annotations.listByDocument(documentId)) {
        if (this.indexAnnotation(annotation.id)) entries += 1;
      }
      return entries;
    })();

    this.logger.info('reindexed document', { documentId, entries: written });
    return written;
  }

  /** Drop every entry belonging to a document. Used when the document is deleted. */
  removeDocument(documentId: string): number {
    const removed = this.db.searchIndex.removeForDocument(documentId);
    this.logger.info('removed document from index', { documentId, entries: removed });
    return removed;
  }
}
