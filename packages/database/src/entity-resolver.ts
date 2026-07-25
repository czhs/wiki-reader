import type { Database as SqliteDatabase } from 'better-sqlite3';
import { anchorToLocation, chunkToLocation } from '@wr/document-model';
import {
  AnnotationAnchorSchema,
  DocumentIdSchema,
  type DocumentId,
  type DocumentLocation,
  type LinkableEntityType,
} from '@wr/shared-types';

/**
 * Resolves an (entityType, entityId) pair into everything the navigation UI needs:
 * a title, the document it lives in, an excerpt, and a precise location.
 *
 * Link results, the peek widget and `goToParent` all need the same projection, so it
 * lives in one place. An unresolvable pair returns `null`, which the callers surface as
 * a broken link rather than silently dropping.
 */

export interface EntityDescription {
  readonly entityType: LinkableEntityType;
  readonly entityId: string;
  readonly title: string;
  readonly documentId: DocumentId | null;
  readonly excerpt: string;
  readonly location: DocumentLocation | null;
}

const EXCERPT_LIMIT = 240;

function truncate(text: string, limit = EXCERPT_LIMIT): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function asDocumentId(value: string | null): DocumentId | null {
  return value === null ? null : DocumentIdSchema.parse(value);
}

export class EntityResolver {
  constructor(private readonly db: SqliteDatabase) {}

  describe(entityType: LinkableEntityType, entityId: string): EntityDescription | null {
    switch (entityType) {
      case 'document':
        return this.describeDocument(entityId);
      case 'annotation':
        return this.describeAnnotation(entityId);
      case 'note':
        return this.describeNote(entityId);
      case 'chunk':
        return this.describeChunk(entityId);
      case 'collection':
        return this.describeCollection(entityId);
      // Headings, figures, citations and excerpts are not persisted as first-class rows
      // in milestone 1. They resolve through the entity they were derived from, so a
      // direct lookup legitimately has nothing to return.
      case 'heading':
      case 'figure':
      case 'citation':
      case 'excerpt':
        return null;
    }
  }

  /**
   * The immediate semantic parent, following `docs/SPEC.md` § Go to parent.
   *
   * An explicit `child-of` edge always wins; otherwise the containment implied by the
   * entity's own row is used.
   */
  parentOf(entityType: LinkableEntityType, entityId: string): EntityDescription | null {
    const explicit = this.db
      .prepare(
        `SELECT target_type, target_id FROM links
          WHERE type = 'child-of' AND source_type = ? AND source_id = ?
          ORDER BY created_at LIMIT 1`,
      )
      .get(entityType, entityId) as { target_type: string; target_id: string } | undefined;
    if (explicit !== undefined) {
      return this.describe(explicit.target_type as LinkableEntityType, explicit.target_id);
    }

    switch (entityType) {
      case 'annotation': {
        const row = this.db
          .prepare('SELECT document_id FROM annotations WHERE id = ?')
          .get(entityId) as { document_id: string } | undefined;
        if (row === undefined) return null;
        // The parent document opened at the annotation's own location, so going up from
        // a highlight lands on its page rather than page 1.
        const parent = this.describeDocument(row.document_id);
        if (parent === null) return null;
        const annotation = this.describeAnnotation(entityId);
        return annotation?.location == null
          ? parent
          : { ...parent, location: annotation.location };
      }
      case 'chunk': {
        const row = this.db
          .prepare('SELECT document_id FROM document_chunks WHERE id = ?')
          .get(entityId) as { document_id: string } | undefined;
        return row === undefined ? null : this.describeDocument(row.document_id);
      }
      case 'excerpt': {
        // An excerpt's parent is the annotation it was derived from.
        const row = this.db
          .prepare(
            `SELECT target_type, target_id FROM links
              WHERE type = 'excerpt-derived-from-annotation' AND source_type = 'excerpt'
                AND source_id = ? LIMIT 1`,
          )
          .get(entityId) as { target_type: string; target_id: string } | undefined;
        return row === undefined
          ? null
          : this.describe(row.target_type as LinkableEntityType, row.target_id);
      }
      case 'document': {
        // A document's parent is the collection containing it, mirroring Zotero.
        const row = this.db
          .prepare(
            `SELECT c.id FROM collections c
               JOIN document_collections dc ON dc.collection_id = c.id
              WHERE dc.document_id = ?
              ORDER BY c.name LIMIT 1`,
          )
          .get(entityId) as { id: string } | undefined;
        return row === undefined ? null : this.describeCollection(row.id);
      }
      case 'heading':
      case 'figure':
      case 'citation':
      case 'note':
      case 'collection':
        return null;
    }
  }

  private describeDocument(id: string): EntityDescription | null {
    const row = this.db
      .prepare('SELECT id, title, abstract FROM documents WHERE id = ?')
      .get(id) as { id: string; title: string; abstract: string | null } | undefined;
    if (row === undefined) return null;
    return {
      entityType: 'document',
      entityId: row.id,
      title: row.title,
      documentId: asDocumentId(row.id),
      excerpt: truncate(row.abstract ?? ''),
      location: null,
    };
  }

  private describeAnnotation(id: string): EntityDescription | null {
    const row = this.db
      .prepare(
        `SELECT a.id, a.document_id, a.selected_text, a.comment, an.anchor_json
           FROM annotations a
           JOIN annotation_anchors an ON an.annotation_id = a.id
          WHERE a.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          document_id: string;
          selected_text: string;
          comment: string | null;
          anchor_json: string;
        }
      | undefined;
    if (row === undefined) return null;
    const anchor = AnnotationAnchorSchema.parse(JSON.parse(row.anchor_json) as unknown);
    return {
      entityType: 'annotation',
      entityId: row.id,
      title: truncate(row.selected_text, 80),
      documentId: asDocumentId(row.document_id),
      excerpt: truncate(row.comment === null ? row.selected_text : `${row.selected_text} — ${row.comment}`),
      location: anchorToLocation(anchor),
    };
  }

  private describeNote(id: string): EntityDescription | null {
    const row = this.db
      .prepare('SELECT id, title, content_text FROM notes WHERE id = ?')
      .get(id) as { id: string; title: string; content_text: string } | undefined;
    if (row === undefined) return null;
    return {
      entityType: 'note',
      entityId: row.id,
      title: row.title,
      documentId: null,
      excerpt: truncate(row.content_text),
      location: { kind: 'note' },
    };
  }

  private describeChunk(id: string): EntityDescription | null {
    const row = this.db
      .prepare(
        `SELECT c.id, c.document_id, c.kind, c.page_index, c.section_path, c.chunk_index,
                c.text, d.title
           FROM document_chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE c.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          document_id: string;
          kind: 'pdf-page' | 'html-section' | 'note-block';
          page_index: number | null;
          section_path: string | null;
          chunk_index: number;
          text: string;
          title: string;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      entityType: 'chunk',
      entityId: row.id,
      title: row.title,
      documentId: asDocumentId(row.document_id),
      excerpt: truncate(row.text),
      location: chunkToLocation({
        kind: row.kind,
        pageIndex: row.page_index,
        sectionPath: row.section_path,
        chunkIndex: row.chunk_index,
      }),
    };
  }

  private describeCollection(id: string): EntityDescription | null {
    const row = this.db
      .prepare('SELECT id, name FROM collections WHERE id = ?')
      .get(id) as { id: string; name: string } | undefined;
    if (row === undefined) return null;
    return {
      entityType: 'collection',
      entityId: row.id,
      title: row.name,
      documentId: null,
      excerpt: '',
      location: null,
    };
  }
}
