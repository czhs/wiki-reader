import type { Database as SqliteDatabase } from 'better-sqlite3';
import { anchorToLocation, chunkToLocation } from '@wr/document-model';
import {
  AnnotationAnchorSchema,
  DocumentIdSchema,
  parseJournalEntityId,
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
      case 'question':
        return this.describeQuestion(entityId);
      case 'hypothesis':
        return this.describeHypothesis(entityId);
      case 'journal':
        return this.describeJournalEntry(entityId);
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
      case 'hypothesis': {
        // A claim's parent is the question it was asked under, which is also the page it is
        // written on. Going up from a hypothesis lands somewhere real.
        const row = this.db
          .prepare('SELECT question_id FROM hypotheses WHERE id = ?')
          .get(entityId) as { question_id: string } | undefined;
        return row === undefined ? null : this.describeQuestion(row.question_id);
      }
      case 'journal': {
        // A day's parent is the notebook it was written under (`P02`). Going up from the 4th
        // lands on the work it was a day of, which is the only thing above it.
        const parsed = parseJournalEntityId(entityId);
        return parsed === null ? null : this.describeQuestion(parsed.notebookId);
      }
      case 'heading':
      case 'figure':
      case 'citation':
      case 'note':
      case 'question':
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

  private describeQuestion(id: string): EntityDescription | null {
    const row = this.db
      .prepare('SELECT id, title, status, next_action FROM questions WHERE id = ?')
      .get(id) as
      | { id: string; title: string; status: string; next_action: string | null }
      | undefined;
    if (row === undefined) return null;
    return {
      entityType: 'question',
      entityId: row.id,
      title: row.title,
      documentId: null,
      excerpt: truncate(row.next_action ?? row.status),
      location: null,
    };
  }

  /**
   * A claim is titled by what it claims. There is nothing shorter to call it, and a
   * citation that showed an id instead would be evidence-shaped rather than evidence.
   */
  private describeHypothesis(id: string): EntityDescription | null {
    const row = this.db
      .prepare('SELECT id, statement, status FROM hypotheses WHERE id = ?')
      .get(id) as { id: string; statement: string; status: string } | undefined;
    if (row === undefined) return null;
    return {
      entityType: 'hypothesis',
      entityId: row.id,
      title: row.statement,
      documentId: null,
      excerpt: truncate(row.status),
      location: null,
    };
  }

  /**
   * A day is addressed by the notebook it belongs to and its date (`P02`).
   *
   * The date alone used to be the whole id, and stopped identifying anything the moment two
   * notebooks could both have been written in on the 4th. The title says which notebook,
   * because "Journal — 2026-03-04" in a list of references is only half an answer.
   */
  private describeJournalEntry(entityId: string): EntityDescription | null {
    const parsed = parseJournalEntityId(entityId);
    if (parsed === null) return null;
    const row = this.db
      .prepare(
        `SELECT j.date AS date, j.markdown AS markdown, q.title AS notebook
           FROM journal_entries j
           JOIN questions q ON q.id = j.notebook_id
          WHERE j.notebook_id = ? AND j.date = ?`,
      )
      .get(parsed.notebookId, parsed.date) as
      | { date: string; markdown: string; notebook: string }
      | undefined;
    if (row === undefined) return null;
    return {
      entityType: 'journal',
      entityId,
      title: `${row.notebook} — ${row.date}`,
      documentId: null,
      excerpt: truncate(row.markdown),
      location: null,
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
