import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import {
  DocumentFileRefSchema,
  type Author,
  type Document,
  type DocumentChunk,
  type DocumentFile,
  type DocumentFileRef,
  type DocumentFileRole,
  type DocumentRevision,
  type DocumentType,
} from '@wr/shared-types';
import type { Clock } from '../clock.js';
import {
  toDocument,
  toDocumentChunk,
  toDocumentFile,
  toDocumentRevision,
  type DocumentChunkRow,
  type DocumentFileRow,
  type DocumentRevisionRow,
  type DocumentRow,
} from '../mappers.js';

const DOCUMENT_COLUMNS = `id, title, doc_type, authors_json, abstract, published_date,
  source, slug, created_at, updated_at, deleted_at`;

export interface CreateDocumentInput {
  readonly title: string;
  readonly docType: DocumentType;
  readonly authors?: readonly Author[] | undefined;
  readonly abstract?: string | null | undefined;
  readonly publishedDate?: string | null | undefined;
  readonly source: string;
  /** Wiki page name, for corpus documents. */
  readonly slug?: string | null | undefined;
}

export interface UpdateDocumentInput {
  readonly title?: string | undefined;
  readonly docType?: DocumentType | undefined;
  readonly authors?: readonly Author[] | undefined;
  readonly abstract?: string | null | undefined;
  readonly publishedDate?: string | null | undefined;
}

export interface ListDocumentsOptions {
  readonly collectionId?: string | undefined;
  readonly tag?: string | undefined;
  /** Case-insensitive substring match on the title. */
  readonly query?: string | undefined;
  /**
   * Restrict to documents that came from one place — `'zotero'`, `'corpus'`.
   *
   * The library sidebar is a view of the Zotero library, so it asks for `'zotero'`. Without
   * this every ingested markdown file appeared in it as a peer of the papers, which is not
   * what the library is.
   */
  readonly source?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly includeDeleted?: boolean | undefined;
}

/** The renderer-safe projection of a file: identifier and URL, never a path. */
export function toDocumentFileRef(file: DocumentFile): DocumentFileRef {
  const { path: _path, ...rest } = file;
  return DocumentFileRefSchema.parse({ ...rest, url: `rrfile://${file.id}` });
}

export class DocumentsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: CreateDocumentInput): Document {
    const now = this.clock.now();
    const id = mintId('document');
    this.db
      .prepare(
        `INSERT INTO documents (id, title, doc_type, authors_json, abstract, published_date,
           source, slug, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.title,
        input.docType,
        JSON.stringify(input.authors ?? []),
        input.abstract ?? null,
        input.publishedDate ?? null,
        input.source,
        input.slug ?? null,
        now,
        now,
      );
    const created = this.getById(id);
    if (created === null) throw new Error(`documents.create: row ${id} vanished after insert`);
    return created;
  }

  update(id: string, patch: UpdateDocumentInput): Document {
    const existing = this.getById(id);
    if (existing === null) throw new Error(`documents.update: ${id} not found`);
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE documents
            SET title = ?, doc_type = ?, authors_json = ?, abstract = ?, published_date = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.title ?? existing.title,
        patch.docType ?? existing.docType,
        JSON.stringify(patch.authors ?? existing.authors),
        patch.abstract === undefined ? existing.abstract : patch.abstract,
        patch.publishedDate === undefined ? existing.publishedDate : patch.publishedDate,
        now,
        id,
      );
    const updated = this.getById(id);
    if (updated === null) throw new Error(`documents.update: ${id} vanished`);
    return updated;
  }

  getById(id: string): Document | null {
    const row = this.db
      .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`)
      .get(id) as DocumentRow | undefined;
    return row === undefined ? null : toDocument(row);
  }

  /**
   * The live document a wiki page name addresses.
   *
   * Two corpus files can carry the same slug (`Notes.md` in two folders). The oldest wins,
   * deterministically, so a `[[Notes]]` edge does not move between the two as rows are
   * updated — an edge that flickers is worse than one that is merely ambiguous.
   */
  getBySlug(slug: string): Document | null {
    const row = this.db
      .prepare(
        `SELECT ${DOCUMENT_COLUMNS} FROM documents
          WHERE slug = ? AND deleted_at IS NULL
          ORDER BY created_at, id
          LIMIT 1`,
      )
      .get(slug) as DocumentRow | undefined;
    return row === undefined ? null : toDocument(row);
  }

  /** Every live document that has a wiki page name, for resolving a corpus in one pass. */
  listSlugged(): Document[] {
    const rows = this.db
      .prepare(
        `SELECT ${DOCUMENT_COLUMNS} FROM documents
          WHERE slug IS NOT NULL AND deleted_at IS NULL
          ORDER BY created_at, id`,
      )
      .all() as DocumentRow[];
    return rows.map(toDocument);
  }

  /** Set or clear a document's wiki page name. */
  setSlug(id: string, slug: string | null): void {
    this.db
      .prepare('UPDATE documents SET slug = ?, updated_at = ? WHERE id = ?')
      .run(slug, this.clock.now(), id);
  }

  list(options: ListDocumentsOptions = {}): { items: Document[]; total: number } {
    const wheres: string[] = [];
    const params: Array<string | number> = [];

    if (options.includeDeleted !== true) wheres.push('d.deleted_at IS NULL');
    if (options.collectionId !== undefined) {
      wheres.push(
        'EXISTS (SELECT 1 FROM document_collections dc WHERE dc.document_id = d.id AND dc.collection_id = ?)',
      );
      params.push(options.collectionId);
    }
    if (options.tag !== undefined) {
      wheres.push(
        `EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
                  WHERE dt.document_id = d.id AND t.name = ?)`,
      );
      params.push(options.tag);
    }
    if (options.query !== undefined && options.query.trim() !== '') {
      wheres.push('d.title LIKE ? ESCAPE \'\\\'');
      params.push(`%${escapeLike(options.query.trim())}%`);
    }
    if (options.source !== undefined) {
      wheres.push('d.source = ?');
      params.push(options.source);
    }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM documents d ${where}`).get(...params) as
        | { n: number }
        | undefined
    )?.n;

    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT d.* FROM documents d ${where}
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as DocumentRow[];

    return { items: rows.map(toDocument), total: total ?? 0 };
  }

  softDelete(id: string): boolean {
    const result = this.db
      .prepare('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(this.clock.now(), this.clock.now(), id);
    return result.changes > 0;
  }

  /**
   * Remove a document and everything the schema hangs off it — files, revisions, chunks,
   * annotations, collection and tag membership, wanted pages, indexing jobs — through the
   * foreign keys' ON DELETE CASCADE.
   *
   * Distinct from `softDelete`, which hides a row that still exists. This is for material
   * that is no longer part of the library at all: a note in a folder the user has stopped
   * using is not a deleted note, it is somebody else's file, and leaving a tombstone for it
   * means the row comes back the moment anything lists deleted documents.
   *
   * `links` and `external_references` address entities by id without a foreign key, so they
   * are not cascaded and the caller must clear them in the same transaction.
   */
  purge(id: string): boolean {
    return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
  }

  /**
   * How many documents arrived after a moment in time.
   *
   * The librarian's schedule runs more often after a *batch* of imports and not at all in
   * response to any single one, so what it needs is a count rather than an event.
   */
  countCreatedSince(iso: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND created_at > ?',
      )
      .get(iso) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL')
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

// ---------------------------------------------------------------------------

export interface CreateRevisionInput {
  readonly documentId: string;
  readonly contentHash: string;
  readonly extractedTextHash?: string | null | undefined;
}

export class DocumentRevisionsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /**
   * Create the next revision of a document. Returns the existing revision when the
   * content hash is unchanged, so re-importing an unmodified file does not fork history.
   */
  createIfChanged(input: CreateRevisionInput): { revision: DocumentRevision; created: boolean } {
    const existing = this.findByContentHash(input.documentId, input.contentHash);
    if (existing !== null) return { revision: existing, created: false };

    const nextNo =
      ((
        this.db
          .prepare('SELECT MAX(revision_no) AS n FROM document_revisions WHERE document_id = ?')
          .get(input.documentId) as { n: number | null } | undefined
      )?.n ?? 0) + 1;

    const id = mintId('documentRevision');
    this.db
      .prepare(
        `INSERT INTO document_revisions
           (id, document_id, revision_no, content_hash, extracted_text_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.documentId,
        nextNo,
        input.contentHash,
        input.extractedTextHash ?? null,
        this.clock.now(),
      );
    const revision = this.getById(id);
    if (revision === null) throw new Error('document_revisions.create: row vanished');
    return { revision, created: true };
  }

  getById(id: string): DocumentRevision | null {
    const row = this.db
      .prepare('SELECT * FROM document_revisions WHERE id = ?')
      .get(id) as DocumentRevisionRow | undefined;
    return row === undefined ? null : toDocumentRevision(row);
  }

  findByContentHash(documentId: string, contentHash: string): DocumentRevision | null {
    const row = this.db
      .prepare('SELECT * FROM document_revisions WHERE document_id = ? AND content_hash = ?')
      .get(documentId, contentHash) as DocumentRevisionRow | undefined;
    return row === undefined ? null : toDocumentRevision(row);
  }

  latestForDocument(documentId: string): DocumentRevision | null {
    const row = this.db
      .prepare(
        'SELECT * FROM document_revisions WHERE document_id = ? ORDER BY revision_no DESC LIMIT 1',
      )
      .get(documentId) as DocumentRevisionRow | undefined;
    return row === undefined ? null : toDocumentRevision(row);
  }

  setExtractedTextHash(revisionId: string, hash: string): void {
    this.db
      .prepare('UPDATE document_revisions SET extracted_text_hash = ? WHERE id = ?')
      .run(hash, revisionId);
  }

  listForDocument(documentId: string): DocumentRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM document_revisions WHERE document_id = ? ORDER BY revision_no')
      .all(documentId) as DocumentRevisionRow[];
    return rows.map(toDocumentRevision);
  }
}

// ---------------------------------------------------------------------------

export interface UpsertFileInput {
  readonly documentId: string;
  readonly revisionId?: string | null | undefined;
  readonly path: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly role: DocumentFileRole;
}

export class DocumentFilesRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /**
   * Insert the file, or update the existing row for the same path.
   *
   * Paths are unique: the same PDF on disk is one row no matter how many times the
   * Zotero library is re-imported.
   */
  upsertByPath(input: UpsertFileInput): { file: DocumentFile; created: boolean } {
    const existing = this.findByPath(input.path);
    if (existing !== null) {
      this.db
        .prepare(
          `UPDATE document_files
              SET document_id = ?, revision_id = ?, mime_type = ?, byte_size = ?,
                  content_hash = ?, role = ?
            WHERE id = ?`,
        )
        .run(
          input.documentId,
          input.revisionId ?? null,
          input.mimeType,
          input.byteSize,
          input.contentHash,
          input.role,
          existing.id,
        );
      const updated = this.getById(existing.id);
      if (updated === null) throw new Error('document_files.upsert: row vanished');
      return { file: updated, created: false };
    }

    const id = mintId('documentFile');
    this.db
      .prepare(
        `INSERT INTO document_files
           (id, document_id, revision_id, path, mime_type, byte_size, content_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.documentId,
        input.revisionId ?? null,
        input.path,
        input.mimeType,
        input.byteSize,
        input.contentHash,
        input.role,
        this.clock.now(),
      );
    const file = this.getById(id);
    if (file === null) throw new Error('document_files.upsert: row vanished after insert');
    return { file, created: true };
  }

  getById(id: string): DocumentFile | null {
    const row = this.db
      .prepare('SELECT * FROM document_files WHERE id = ?')
      .get(id) as DocumentFileRow | undefined;
    return row === undefined ? null : toDocumentFile(row);
  }

  findByPath(path: string): DocumentFile | null {
    const row = this.db
      .prepare('SELECT * FROM document_files WHERE path = ?')
      .get(path) as DocumentFileRow | undefined;
    return row === undefined ? null : toDocumentFile(row);
  }

  listByDocument(documentId: string): DocumentFile[] {
    const rows = this.db
      .prepare('SELECT * FROM document_files WHERE document_id = ? ORDER BY created_at, id')
      .all(documentId) as DocumentFileRow[];
    return rows.map(toDocumentFile);
  }

  /** The file a reader should open for a document: the primary attachment if there is one. */
  primaryForDocument(documentId: string): DocumentFile | null {
    const row = this.db
      .prepare(
        `SELECT * FROM document_files
          WHERE document_id = ?
          ORDER BY CASE role WHEN 'primary' THEN 0 WHEN 'snapshot' THEN 1 ELSE 2 END,
                   created_at
          LIMIT 1`,
      )
      .get(documentId) as DocumentFileRow | undefined;
    return row === undefined ? null : toDocumentFile(row);
  }

  setRevision(fileId: string, revisionId: string): void {
    this.db.prepare('UPDATE document_files SET revision_id = ? WHERE id = ?').run(revisionId, fileId);
  }
}

// ---------------------------------------------------------------------------

export interface ChunkInput {
  readonly chunkIndex: number;
  readonly kind: DocumentChunk['kind'];
  readonly pageIndex?: number | null | undefined;
  readonly sectionPath?: string | null | undefined;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
}

export class DocumentChunksRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** Replace every chunk of a revision atomically. Re-extraction is not additive. */
  replaceForRevision(
    documentId: string,
    revisionId: string,
    chunks: readonly ChunkInput[],
  ): DocumentChunk[] {
    const del = this.db.prepare('DELETE FROM document_chunks WHERE revision_id = ?');
    const insert = this.db.prepare(
      `INSERT INTO document_chunks
         (id, document_id, revision_id, chunk_index, kind, page_index, section_path,
          char_start, char_end, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction((items: readonly ChunkInput[]) => {
      del.run(revisionId);
      for (const chunk of items) {
        insert.run(
          mintId('documentChunk'),
          documentId,
          revisionId,
          chunk.chunkIndex,
          chunk.kind,
          chunk.pageIndex ?? null,
          chunk.sectionPath ?? null,
          chunk.charStart,
          chunk.charEnd,
          chunk.text,
        );
      }
    });
    run(chunks);
    return this.listForRevision(revisionId);
  }

  listForRevision(revisionId: string): DocumentChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM document_chunks WHERE revision_id = ? ORDER BY chunk_index')
      .all(revisionId) as DocumentChunkRow[];
    return rows.map(toDocumentChunk);
  }

  listForDocument(documentId: string): DocumentChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(documentId) as DocumentChunkRow[];
    return rows.map(toDocumentChunk);
  }

  getById(id: string): DocumentChunk | null {
    const row = this.db
      .prepare('SELECT * FROM document_chunks WHERE id = ?')
      .get(id) as DocumentChunkRow | undefined;
    return row === undefined ? null : toDocumentChunk(row);
  }

  countForDocument(documentId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM document_chunks WHERE document_id = ?')
      .get(documentId) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

/** Escape LIKE wildcards in user input; the queries above use `ESCAPE '\'`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
