import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import {
  ResolvedLinkSchema,
  type DocumentLedgerEntry,
  type DocumentLocation,
  type Link,
  type LinkableEntityType,
  type LinkOrigin,
  type ResolvedLink,
} from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { EntityResolver } from '../entity-resolver.js';
import { serializeLocation, toLink, type LinkRow } from '../mappers.js';

export type LinkDirection = 'incoming' | 'outgoing' | 'both';

export interface CreateLinkInput {
  readonly type: string;
  readonly sourceType: LinkableEntityType;
  readonly sourceId: string;
  readonly targetType: LinkableEntityType;
  readonly targetId: string;
  readonly sourceLocation?: DocumentLocation | null | undefined;
  readonly targetLocation?: DocumentLocation | null | undefined;
  readonly label?: string | null | undefined;
  readonly ordinal?: number | null | undefined;
  readonly origin?: LinkOrigin | undefined;
  readonly generator?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | null | undefined;
}

export interface FindReferencesOptions {
  readonly entityType: LinkableEntityType;
  readonly entityId: string;
  readonly direction?: LinkDirection | undefined;
  readonly limit?: number | undefined;
}

export interface FindByTypeOptions {
  readonly type: string;
  readonly documentId?: string | undefined;
  readonly collectionId?: string | undefined;
  readonly tag?: string | undefined;
  readonly sourceType?: LinkableEntityType | undefined;
  readonly targetType?: LinkableEntityType | undefined;
  /**
   * Only meaningful together with a scope filter (document / collection / tag):
   * `outgoing` keeps links whose *source* is inside the scope, `incoming` whose target is.
   */
  readonly direction?: LinkDirection | undefined;
  readonly origin?: LinkOrigin | undefined;
  readonly generator?: string | undefined;
  readonly createdAfter?: string | undefined;
  readonly createdBefore?: string | undefined;
  readonly limit?: number | undefined;
}

const LINK_COLUMNS = `l.id, l.type, l.source_type, l.source_id, l.target_type, l.target_id,
  l.source_location_json, l.target_location_json, l.label, l.ordinal, l.origin, l.generator,
  l.metadata_json, l.created_at, l.updated_at`;

/**
 * Typed directed edges.
 *
 * Queries here are always index-driven and always bounded: the renderer asks for the
 * links of one entity or one type, never for the whole graph.
 */
export class LinksRepository {
  private readonly resolver: EntityResolver;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {
    this.resolver = new EntityResolver(db);
  }

  /**
   * Create the edge, or return the existing one.
   *
   * (type, source, target) is unique: linking the same two entities the same way twice is
   * the same fact, not two facts.
   */
  create(input: CreateLinkInput): Link {
    const existing = this.find(
      input.type,
      input.sourceType,
      input.sourceId,
      input.targetType,
      input.targetId,
    );
    if (existing !== null) return existing;

    const now = this.clock.now();
    const id = mintId('link');
    this.db
      .prepare(
        `INSERT INTO links
           (id, type, source_type, source_id, target_type, target_id, source_location_json,
            target_location_json, label, ordinal, origin, generator, metadata_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.sourceType,
        input.sourceId,
        input.targetType,
        input.targetId,
        serializeLocation(input.sourceLocation),
        serializeLocation(input.targetLocation),
        input.label ?? null,
        input.ordinal ?? null,
        input.origin ?? 'manual',
        input.generator ?? null,
        input.metadata === null || input.metadata === undefined
          ? null
          : JSON.stringify(input.metadata),
        now,
        now,
      );
    const link = this.getById(id);
    if (link === null) throw new Error('links.create: row vanished after insert');
    return link;
  }

  getById(id: string): Link | null {
    const row = this.db
      .prepare(`SELECT ${LINK_COLUMNS} FROM links l WHERE l.id = ?`)
      .get(id) as LinkRow | undefined;
    return row === undefined ? null : toLink(row);
  }

  find(
    type: string,
    sourceType: LinkableEntityType,
    sourceId: string,
    targetType: LinkableEntityType,
    targetId: string,
  ): Link | null {
    const row = this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM links l
          WHERE l.type = ? AND l.source_type = ? AND l.source_id = ?
            AND l.target_type = ? AND l.target_id = ?`,
      )
      .get(type, sourceType, sourceId, targetType, targetId) as LinkRow | undefined;
    return row === undefined ? null : toLink(row);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM links WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Replace the edges one generator derived from one source, leaving every other edge alone.
   *
   * Re-indexing a document has to forget the links its previous text implied — a `[[link]]`
   * the author deleted must not survive as an edge. The obvious implementation, "delete every
   * link whose source is this document", also destroys the links the *user* made by hand, and
   * still passes a test that only checks that wikilinks work. So the delete is scoped by
   * `origin = 'derived'` **and** by the generator: nothing manual, and nothing another
   * generator owns, is inside the blast radius.
   */
  replaceDerived(options: {
    readonly sourceType: LinkableEntityType;
    readonly sourceId: string;
    readonly generator: string;
    readonly links: readonly CreateLinkInput[];
  }): Link[] {
    const remove = this.db.prepare(
      `DELETE FROM links
        WHERE source_type = ? AND source_id = ? AND origin = 'derived' AND generator = ?`,
    );
    const run = this.db.transaction((): Link[] => {
      remove.run(options.sourceType, options.sourceId, options.generator);
      return options.links.map((link) =>
        this.create({ ...link, origin: 'derived', generator: options.generator }),
      );
    });
    return run();
  }

  /** Remove every edge touching an entity. Used when an entity is hard-deleted. */
  deleteForEntity(entityType: LinkableEntityType, entityId: string): number {
    return this.db
      .prepare(
        `DELETE FROM links
          WHERE (source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?)`,
      )
      .run(entityType, entityId, entityType, entityId).changes;
  }

  /** Find All References: every edge touching the entity, in the requested direction. */
  findReferences(options: FindReferencesOptions): ResolvedLink[] {
    const direction = options.direction ?? 'both';
    const limit = options.limit ?? 500;
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (direction === 'outgoing' || direction === 'both') {
      clauses.push('(l.source_type = ? AND l.source_id = ?)');
      params.push(options.entityType, options.entityId);
    }
    if (direction === 'incoming' || direction === 'both') {
      clauses.push('(l.target_type = ? AND l.target_id = ?)');
      params.push(options.entityType, options.entityId);
    }

    const rows = this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM links l
          WHERE ${clauses.join(' OR ')}
          ORDER BY l.created_at, l.id
          LIMIT ?`,
      )
      .all(...params, limit) as LinkRow[];

    return rows.map((row) => this.resolve(toLink(row), options.entityType, options.entityId));
  }

  /** Find All Links of This Type, with the narrowing options from the spec. */
  findByType(options: FindByTypeOptions): ResolvedLink[] {
    const wheres: string[] = ['l.type = ?'];
    const params: Array<string | number> = [options.type];

    if (options.sourceType !== undefined) {
      wheres.push('l.source_type = ?');
      params.push(options.sourceType);
    }
    if (options.targetType !== undefined) {
      wheres.push('l.target_type = ?');
      params.push(options.targetType);
    }
    if (options.origin !== undefined) {
      wheres.push('l.origin = ?');
      params.push(options.origin);
    }
    if (options.generator !== undefined) {
      wheres.push('l.generator = ?');
      params.push(options.generator);
    }
    if (options.createdAfter !== undefined) {
      wheres.push('l.created_at >= ?');
      params.push(options.createdAfter);
    }
    if (options.createdBefore !== undefined) {
      wheres.push('l.created_at <= ?');
      params.push(options.createdBefore);
    }

    const direction = options.direction ?? 'both';
    if (options.documentId !== undefined) {
      wheres.push(scopeClause('SELECT ? AS document_id', direction));
      params.push(options.documentId);
    }
    if (options.collectionId !== undefined) {
      wheres.push(
        scopeClause(
          'SELECT document_id FROM document_collections WHERE collection_id = ?',
          direction,
        ),
      );
      params.push(options.collectionId);
    }
    if (options.tag !== undefined) {
      wheres.push(
        scopeClause(
          `SELECT dt.document_id AS document_id FROM document_tags dt
             JOIN tags t ON t.id = dt.tag_id WHERE t.name = ?`,
          direction,
        ),
      );
      params.push(options.tag);
    }

    const rows = this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM links l
          WHERE ${wheres.join(' AND ')}
          ORDER BY l.created_at, l.id
          LIMIT ?`,
      )
      .all(...params, options.limit ?? 500) as LinkRow[];

    // Without an anchor entity, "the other endpoint" is the target: these results are read
    // as "source -> target" rows.
    return rows.map((row) => {
      const link = toLink(row);
      return this.resolve(link, link.sourceType, link.sourceId);
    });
  }

  /**
   * Every edge on one file, whatever its type and whichever end of it is inside (`H03`).
   *
   * The same "inside this document" test `findByType` uses through `scopeClause` — the file
   * itself, an annotation of it, or one of its chunks — but with no type filter, which is the
   * whole difference. A ledger asked one type at a time is a ledger that only shows the
   * relationships whoever wrote the panel happened to think of, and the type vocabulary here
   * is deliberately open-ended: the librarian may invent one.
   *
   * Each row says which end was the near one, because a `ResolvedLink` alone cannot: it
   * describes the endpoint away from the query, and "the query" here is a file rather than an
   * entity. Ties go to the source, so an edge between two highlights of the same paper reads
   * as one outgoing line rather than as the same fact twice.
   *
   * Two things are left out, both because they are not connections.
   *
   * A *derived* edge with both ends inside this file is bookkeeping: every highlight carries
   * `annotation-belongs-to-document` to the paper it was made in, so a ledger that listed them
   * would open with one line per highlight saying the highlight is in the file whose ledger you
   * are reading. An edge inside the file that the *researcher* made — one marked sentence
   * bearing on another in the same paper — is a real claim and stays.
   *
   * And a deleted highlight's links. They are still in the table, because removing a document
   * keeps its annotations and links recoverable (`B03`), but a ledger is a view of what this
   * file says now.
   */
  findForDocument(options: {
    readonly documentId: string;
    readonly limit?: number | undefined;
  }): DocumentLedgerEntry[] {
    const inside = (type: string, id: string): string =>
      `((${type} = 'document' AND ${id} = @documentId)
        OR (${type} = 'annotation'
            AND ${id} IN (SELECT a.id FROM annotations a
                           WHERE a.document_id = @documentId AND a.deleted_at IS NULL))
        OR (${type} = 'chunk'
            AND ${id} IN (SELECT c.id FROM document_chunks c WHERE c.document_id = @documentId)))`;

    const rows = this.db
      .prepare(
        `SELECT ${LINK_COLUMNS},
                CASE WHEN ${inside('l.source_type', 'l.source_id')} THEN 1 ELSE 0 END AS near_source
           FROM links l
          WHERE (${inside('l.source_type', 'l.source_id')}
                 OR ${inside('l.target_type', 'l.target_id')})
            AND NOT (l.origin = 'derived'
                     AND ${inside('l.source_type', 'l.source_id')}
                     AND ${inside('l.target_type', 'l.target_id')})
          ORDER BY l.created_at, l.id
          LIMIT @limit`,
      )
      .all({ documentId: options.documentId, limit: options.limit ?? 500 }) as (LinkRow & {
      near_source: number;
    })[];

    return rows.map((row) => {
      const link = toLink(row);
      const nearIsSource = row.near_source === 1;
      const nearType = nearIsSource ? link.sourceType : link.targetType;
      const nearId = nearIsSource ? link.sourceId : link.targetId;
      const described = this.resolver.describe(nearType, nearId);
      return {
        near: {
          entityType: nearType,
          entityId: nearId,
          label: described?.excerpt ?? described?.title ?? '',
        },
        link: this.resolve(link, nearType, nearId),
      };
    });
  }

  counts(entityType: LinkableEntityType, entityId: string): { incoming: number; outgoing: number } {
    const outgoing = this.db
      .prepare('SELECT COUNT(*) AS n FROM links WHERE source_type = ? AND source_id = ?')
      .get(entityType, entityId) as { n: number } | undefined;
    const incoming = this.db
      .prepare('SELECT COUNT(*) AS n FROM links WHERE target_type = ? AND target_id = ?')
      .get(entityType, entityId) as { n: number } | undefined;
    return { incoming: incoming?.n ?? 0, outgoing: outgoing?.n ?? 0 };
  }

  /** Attach display information for the endpoint opposite `anchorType`/`anchorId`. */
  private resolve(link: Link, anchorType: LinkableEntityType, anchorId: string): ResolvedLink {
    const isSource = link.sourceType === anchorType && link.sourceId === anchorId;
    const direction = isSource ? 'outgoing' : 'incoming';
    const otherType = isSource ? link.targetType : link.sourceType;
    const otherId = isSource ? link.targetId : link.sourceId;
    const declaredLocation = isSource ? link.targetLocation : link.sourceLocation;
    const described = this.resolver.describe(otherType, otherId);

    return ResolvedLinkSchema.parse({
      ...link,
      direction,
      otherTitle: described?.title ?? '',
      otherType,
      otherDocumentId: described?.documentId ?? null,
      excerpt: described?.excerpt ?? null,
      broken: described === null,
      otherLocation: declaredLocation ?? described?.location ?? null,
    });
  }
}

/**
 * SQL fragment restricting a link to endpoints that live inside a set of documents.
 *
 * `documentsSql` must produce a single `document_id` column. An endpoint is inside the
 * scope when it is the document itself, or an annotation or chunk belonging to it.
 */
function scopeClause(documentsSql: string, direction: LinkDirection): string {
  const side = (type: string, id: string): string =>
    `((${type} = 'document' AND ${id} = ds.document_id)
      OR (${type} = 'annotation'
          AND ${id} IN (SELECT a.id FROM annotations a WHERE a.document_id = ds.document_id))
      OR (${type} = 'chunk'
          AND ${id} IN (SELECT c.id FROM document_chunks c WHERE c.document_id = ds.document_id)))`;

  const parts: string[] = [];
  if (direction === 'outgoing' || direction === 'both') {
    parts.push(side('l.source_type', 'l.source_id'));
  }
  if (direction === 'incoming' || direction === 'both') {
    parts.push(side('l.target_type', 'l.target_id'));
  }
  return `EXISTS (SELECT 1 FROM (${documentsSql}) ds WHERE ${parts.join(' OR ')})`;
}
