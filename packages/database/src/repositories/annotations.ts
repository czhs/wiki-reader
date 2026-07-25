import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import {
  AnnotationWithAnchorSchema,
  type Annotation,
  type AnnotationAnchor,
  type AnnotationKind,
  type AnnotationWithAnchor,
} from '@wr/shared-types';
import type { Clock } from '../clock.js';
import {
  toAnnotation,
  toAnnotationAnchor,
  type AnnotationAnchorRow,
  type AnnotationRow,
} from '../mappers.js';

export interface CreateAnnotationInput {
  readonly documentId: string;
  readonly revisionId?: string | null | undefined;
  readonly kind: AnnotationKind;
  readonly color: string;
  readonly selectedText: string;
  readonly comment?: string | null | undefined;
  readonly anchor: AnnotationAnchor;
}

export interface UpdateAnnotationInput {
  readonly color?: string | undefined;
  readonly comment?: string | null | undefined;
}

interface AnnotationJoinedRow extends AnnotationRow {
  anchor_id: string;
  anchor_json: string;
}

interface AnchorColumns {
  readonly pageIndex: number | null;
  readonly sectionPath: string | null;
  readonly textHash: string;
  readonly contentHash: string;
}

/**
 * Project an anchor onto the queryable columns beside its JSON.
 *
 * The JSON is the record; these columns exist so "which highlights are on page 4" and "which
 * anchors were made against bytes that have since changed" are indexed lookups. Each anchor
 * kind names its own hashes, so the mapping is explicit per kind rather than a two-branch
 * ternary that silently attributes one kind's field to another.
 */
function anchorColumns(anchor: AnnotationAnchor): AnchorColumns {
  switch (anchor.kind) {
    case 'pdf':
      return {
        pageIndex: anchor.pageIndex,
        sectionPath: null,
        textHash: anchor.pageTextHash,
        contentHash: anchor.contentHash,
      };
    case 'html':
      return {
        pageIndex: null,
        sectionPath: anchor.sectionPath ?? null,
        textHash: anchor.snapshotHash,
        contentHash: anchor.snapshotHash,
      };
    case 'markdown':
      return {
        pageIndex: null,
        sectionPath: anchor.headingPath ?? null,
        textHash: anchor.documentTextHash,
        contentHash: anchor.sourceHash,
      };
  }
}

/**
 * Annotations and their anchors.
 *
 * The anchor is written in the same transaction as the annotation: an annotation without
 * anchoring evidence could never be rendered again, so a partial write is not allowed to
 * survive. The `annotation-belongs-to-document` edge is created here too, so
 * `goToParent` works through the ordinary link table rather than a special case.
 */
export class AnnotationsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: CreateAnnotationInput): AnnotationWithAnchor {
    const now = this.clock.now();
    const annotationId = mintId('annotation');
    const anchorId = mintId('annotationAnchor');
    const anchor = input.anchor;

    const insertAnnotation = this.db.prepare(
      `INSERT INTO annotations
         (id, document_id, revision_id, kind, color, selected_text, comment,
          created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    const insertAnchor = this.db.prepare(
      `INSERT INTO annotation_anchors
         (id, annotation_id, kind, anchor_json, page_index, section_path, text_hash,
          content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLink = this.db.prepare(
      `INSERT OR IGNORE INTO links
         (id, type, source_type, source_id, target_type, target_id, source_location_json,
          target_location_json, label, ordinal, origin, generator, metadata_json,
          created_at, updated_at)
       VALUES (?, 'annotation-belongs-to-document', 'annotation', ?, 'document', ?, NULL,
               NULL, NULL, NULL, 'derived', 'annotations-repository', NULL, ?, ?)`,
    );

    const run = this.db.transaction(() => {
      insertAnnotation.run(
        annotationId,
        input.documentId,
        input.revisionId ?? null,
        input.kind,
        input.color,
        input.selectedText,
        input.comment ?? null,
        now,
        now,
      );
      const columns = anchorColumns(anchor);
      insertAnchor.run(
        anchorId,
        annotationId,
        anchor.kind,
        JSON.stringify(anchor),
        columns.pageIndex,
        columns.sectionPath,
        columns.textHash,
        columns.contentHash,
        now,
      );
      insertLink.run(mintId('link'), annotationId, input.documentId, now, now);
    });
    run();

    const created = this.get(annotationId);
    if (created === null) throw new Error('annotations.create: row vanished after insert');
    return created;
  }

  get(id: string): AnnotationWithAnchor | null {
    const row = this.db
      .prepare(
        `SELECT a.*, an.id AS anchor_id, an.anchor_json
           FROM annotations a
           JOIN annotation_anchors an ON an.annotation_id = a.id
          WHERE a.id = ?`,
      )
      .get(id) as AnnotationJoinedRow | undefined;
    return row === undefined ? null : this.toWithAnchor(row);
  }

  listByDocument(documentId: string, includeDeleted = false): AnnotationWithAnchor[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, an.id AS anchor_id, an.anchor_json
           FROM annotations a
           JOIN annotation_anchors an ON an.annotation_id = a.id
          WHERE a.document_id = ?
            ${includeDeleted ? '' : 'AND a.deleted_at IS NULL'}
          ORDER BY an.page_index, a.created_at, a.id`,
      )
      .all(documentId) as AnnotationJoinedRow[];
    return rows.map((row) => this.toWithAnchor(row));
  }

  update(id: string, patch: UpdateAnnotationInput): Annotation {
    const existing = this.db
      .prepare('SELECT * FROM annotations WHERE id = ?')
      .get(id) as AnnotationRow | undefined;
    if (existing === undefined) throw new Error(`annotations.update: ${id} not found`);
    const current = toAnnotation(existing);
    this.db
      .prepare('UPDATE annotations SET color = ?, comment = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.color ?? current.color,
        patch.comment === undefined ? current.comment : patch.comment,
        this.clock.now(),
        id,
      );
    const row = this.db
      .prepare('SELECT * FROM annotations WHERE id = ?')
      .get(id) as AnnotationRow | undefined;
    if (row === undefined) throw new Error(`annotations.update: ${id} vanished`);
    return toAnnotation(row);
  }

  softDelete(id: string): boolean {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        'UPDATE annotations SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      )
      .run(now, now, id);
    return result.changes > 0;
  }

  anchorOf(annotationId: string): AnnotationAnchor | null {
    const row = this.db
      .prepare('SELECT * FROM annotation_anchors WHERE annotation_id = ?')
      .get(annotationId) as AnnotationAnchorRow | undefined;
    return row === undefined ? null : toAnnotationAnchor(row);
  }

  countForDocument(documentId: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM annotations WHERE document_id = ? AND deleted_at IS NULL',
      )
      .get(documentId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  private toWithAnchor(row: AnnotationJoinedRow): AnnotationWithAnchor {
    const annotation = toAnnotation(row);
    return AnnotationWithAnchorSchema.parse({
      ...annotation,
      anchorId: row.anchor_id,
      anchor: JSON.parse(row.anchor_json) as unknown,
    });
  }
}
