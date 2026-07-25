import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import type { Collection, Tag } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { toCollection, toTag, type CollectionRow, type TagRow } from '../mappers.js';

export interface CreateCollectionInput {
  readonly name: string;
  readonly parentId?: string | null | undefined;
}

export class CollectionsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: CreateCollectionInput): Collection {
    const now = this.clock.now();
    const id = mintId('collection');
    this.db
      .prepare(
        'INSERT INTO collections (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name, input.parentId ?? null, now, now);
    const collection = this.getById(id);
    if (collection === null) throw new Error('collections.create: row vanished after insert');
    return collection;
  }

  update(id: string, patch: CreateCollectionInput): Collection {
    this.db
      .prepare('UPDATE collections SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?')
      .run(patch.name, patch.parentId ?? null, this.clock.now(), id);
    const collection = this.getById(id);
    if (collection === null) throw new Error(`collections.update: ${id} not found`);
    return collection;
  }

  getById(id: string): Collection | null {
    const row = this.db
      .prepare('SELECT * FROM collections WHERE id = ?')
      .get(id) as CollectionRow | undefined;
    return row === undefined ? null : toCollection(row);
  }

  list(): Collection[] {
    const rows = this.db
      .prepare('SELECT * FROM collections ORDER BY name, id')
      .all() as CollectionRow[];
    return rows.map(toCollection);
  }

  /** Replace a document's collection membership. */
  setDocumentCollections(documentId: string, collectionIds: readonly string[]): void {
    const clear = this.db.prepare('DELETE FROM document_collections WHERE document_id = ?');
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO document_collections (document_id, collection_id) VALUES (?, ?)',
    );
    const run = this.db.transaction((ids: readonly string[]) => {
      clear.run(documentId);
      for (const collectionId of ids) insert.run(documentId, collectionId);
    });
    run(collectionIds);
  }

  collectionIdsForDocument(documentId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT collection_id FROM document_collections WHERE document_id = ? ORDER BY collection_id`,
      )
      .all(documentId) as Array<{ collection_id: string }>;
    return rows.map((row) => row.collection_id);
  }

  documentCount(collectionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM document_collections WHERE collection_id = ?')
      .get(collectionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

export class TagsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** Tags are unique by name; importing the same tag twice returns the existing row. */
  upsertByName(name: string): Tag {
    const existing = this.findByName(name);
    if (existing !== null) return existing;
    const id = mintId('tag');
    this.db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, name);
    const created = this.findByName(name);
    if (created === null) throw new Error('tags.upsertByName: row vanished after insert');
    return created;
  }

  findByName(name: string): Tag | null {
    const row = this.db.prepare('SELECT * FROM tags WHERE name = ?').get(name) as TagRow | undefined;
    return row === undefined ? null : toTag(row);
  }

  list(): Tag[] {
    const rows = this.db.prepare('SELECT * FROM tags ORDER BY name').all() as TagRow[];
    return rows.map(toTag);
  }

  /** Replace a document's tags, creating any tag that does not exist yet. */
  setDocumentTags(documentId: string, names: readonly string[]): Tag[] {
    const clear = this.db.prepare('DELETE FROM document_tags WHERE document_id = ?');
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)',
    );
    const applied: Tag[] = [];
    const run = this.db.transaction((tagNames: readonly string[]) => {
      clear.run(documentId);
      for (const name of tagNames) {
        const tag = this.upsertByName(name);
        insert.run(documentId, tag.id);
        applied.push(tag);
      }
    });
    run(names);
    return applied;
  }

  namesForDocument(documentId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.name FROM tags t
           JOIN document_tags dt ON dt.tag_id = t.id
          WHERE dt.document_id = ?
          ORDER BY t.name`,
      )
      .all(documentId) as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }
}
