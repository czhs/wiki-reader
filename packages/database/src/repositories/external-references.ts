import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import type { ExternalReference } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { toExternalReference, type ExternalReferenceRow } from '../mappers.js';

export type ExternalEntityType = ExternalReference['entityType'];

export interface UpsertExternalReferenceInput {
  readonly entityType: ExternalEntityType;
  readonly entityId: string;
  readonly provider: string;
  readonly externalKey: string;
  readonly externalVersion?: number | null | undefined;
  readonly payload?: unknown;
}

/**
 * Provenance for imported records.
 *
 * This table is what makes re-import idempotent. A Zotero item key is looked up here
 * first; if it is already known, the existing internal entity is updated instead of a
 * second one being created. Zotero keys are never used as internal primary keys.
 */
export class ExternalReferencesRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  upsert(input: UpsertExternalReferenceInput): ExternalReference {
    const now = this.clock.now();
    const existing = this.find(input.provider, input.entityType, input.externalKey);
    if (existing !== null) {
      this.db
        .prepare(
          `UPDATE external_references
              SET entity_id = ?, external_version = ?, payload_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.entityId,
          input.externalVersion ?? null,
          input.payload === undefined ? null : JSON.stringify(input.payload),
          now,
          existing.id,
        );
      const updated = this.getById(existing.id);
      if (updated === null) throw new Error('external_references.upsert: row vanished');
      return updated;
    }

    const id = mintId('externalReference');
    this.db
      .prepare(
        `INSERT INTO external_references
           (id, entity_type, entity_id, provider, external_key, external_version,
            payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.entityType,
        input.entityId,
        input.provider,
        input.externalKey,
        input.externalVersion ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        now,
        now,
      );
    const created = this.getById(id);
    if (created === null) throw new Error('external_references.upsert: row vanished after insert');
    return created;
  }

  getById(id: string): ExternalReference | null {
    const row = this.db
      .prepare('SELECT * FROM external_references WHERE id = ?')
      .get(id) as ExternalReferenceRow | undefined;
    return row === undefined ? null : toExternalReference(row);
  }

  find(
    provider: string,
    entityType: ExternalEntityType,
    externalKey: string,
  ): ExternalReference | null {
    const row = this.db
      .prepare(
        `SELECT * FROM external_references
          WHERE provider = ? AND entity_type = ? AND external_key = ?`,
      )
      .get(provider, entityType, externalKey) as ExternalReferenceRow | undefined;
    return row === undefined ? null : toExternalReference(row);
  }

  /** The internal entity id a provider key maps to, or null when it is unknown. */
  resolveEntityId(
    provider: string,
    entityType: ExternalEntityType,
    externalKey: string,
  ): string | null {
    return this.find(provider, entityType, externalKey)?.entityId ?? null;
  }

  listForEntity(entityType: ExternalEntityType, entityId: string): ExternalReference[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM external_references WHERE entity_type = ? AND entity_id = ? ORDER BY provider',
      )
      .all(entityType, entityId) as ExternalReferenceRow[];
    return rows.map(toExternalReference);
  }

  /**
   * Forget every provider key for an entity. Called when the entity itself is purged: this
   * table has no foreign key onto the entities it names, so nothing cascades, and a stale
   * row here would claim a Zotero key still maps to a document that no longer exists.
   */
  deleteForEntity(entityType: ExternalEntityType, entityId: string): number {
    return this.db
      .prepare('DELETE FROM external_references WHERE entity_type = ? AND entity_id = ?')
      .run(entityType, entityId).changes;
  }
}
