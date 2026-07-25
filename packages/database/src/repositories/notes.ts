import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import type { Note } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { toNote, type NoteRow } from '../mappers.js';

export interface CreateNoteInput {
  readonly title: string;
  /** Tiptap/ProseMirror JSON. Stored verbatim. */
  readonly contentJson: unknown;
  /** Flattened text, kept in sync by the caller for FTS indexing. */
  readonly contentText: string;
}

export interface UpdateNoteInput {
  readonly title?: string | undefined;
  readonly contentJson?: unknown;
  readonly contentText?: string | undefined;
}

export class NotesRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: CreateNoteInput): Note {
    const now = this.clock.now();
    const id = mintId('note');
    this.db
      .prepare(
        `INSERT INTO notes (id, title, content_json, content_text, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, input.title, JSON.stringify(input.contentJson ?? null), input.contentText, now, now);
    const note = this.get(id);
    if (note === null) throw new Error('notes.create: row vanished after insert');
    return note;
  }

  get(id: string): Note | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    return row === undefined ? null : toNote(row);
  }

  update(id: string, patch: UpdateNoteInput): Note {
    const existing = this.get(id);
    if (existing === null) throw new Error(`notes.update: ${id} not found`);
    this.db
      .prepare('UPDATE notes SET title = ?, content_json = ?, content_text = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.title ?? existing.title,
        JSON.stringify(patch.contentJson === undefined ? existing.contentJson : patch.contentJson),
        patch.contentText ?? existing.contentText,
        this.clock.now(),
        id,
      );
    const updated = this.get(id);
    if (updated === null) throw new Error(`notes.update: ${id} vanished`);
    return updated;
  }

  list(limit = 200, offset = 0): { notes: Note[]; total: number } {
    const total =
      (this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL').get() as
        | { n: number }
        | undefined)?.n ?? 0;
    const rows = this.db
      .prepare(
        'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as NoteRow[];
    return { notes: rows.map(toNote), total };
  }

  /** Notes linked to an annotation by a `note-references-annotation` edge. */
  listForAnnotation(annotationId: string): Note[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM notes n
           JOIN links l ON l.source_type = 'note' AND l.source_id = n.id
          WHERE l.type = 'note-references-annotation'
            AND l.target_type = 'annotation'
            AND l.target_id = ?
            AND n.deleted_at IS NULL
          ORDER BY n.created_at, n.id`,
      )
      .all(annotationId) as NoteRow[];
    return rows.map(toNote);
  }

  /** Notes linked to a document by a `note-references-document` edge. */
  listForDocument(documentId: string): Note[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM notes n
           JOIN links l ON l.source_type = 'note' AND l.source_id = n.id
          WHERE l.type = 'note-references-document'
            AND l.target_type = 'document'
            AND l.target_id = ?
            AND n.deleted_at IS NULL
          ORDER BY n.created_at, n.id`,
      )
      .all(documentId) as NoteRow[];
    return rows.map(toNote);
  }

  softDelete(id: string): boolean {
    const now = this.clock.now();
    const result = this.db
      .prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now, now, id);
    return result.changes > 0;
  }
}
