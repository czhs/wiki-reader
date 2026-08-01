/**
 * Query execution and result mapping.
 *
 * The contract that matters here is criterion M10: every result carries enough information
 * to open the right document *at the right place*. That location is read back from the index
 * row rather than recomputed, so a result stays openable even if the source file has since
 * moved or the reader is not loaded.
 */
import {
  DocumentIdSchema,
  DocumentLocationSchema,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  stripSnippetMarkers,
  type DocumentId,
  type DocumentLocation,
  type SearchFilters,
  type SearchResult,
} from '@wr/shared-types';
import type { WikiReaderDatabase } from '@wr/database';
import { parseQuery, type ParsedQuery } from './query.js';

/**
 * The snippet delimiters are the contract of the field, not a detail of this query: the search
 * panel splits on the same two code points to draw the match. They live in `@wr/shared-types`
 * beside `SearchResultSchema`, and are re-exported here because this is where they are written.
 */
export { SNIPPET_CLOSE, SNIPPET_OPEN, stripSnippetMarkers };
const SNIPPET_ELLIPSIS = '…';
const SNIPPET_TOKENS = 24;

export interface SearchOptions {
  readonly filters?: SearchFilters | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** Match the final word as a prefix, for search-as-you-type. */
  readonly prefixLastTerm?: boolean | undefined;
}

export interface SearchResponse {
  readonly results: SearchResult[];
  readonly total: number;
  readonly normalizedQuery: string;
  readonly durationMs: number;
}

interface SearchRow {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly document_id: string | null;
  readonly location_json: string | null;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
}

const ENTITY_TYPES = ['document', 'chunk', 'annotation', 'note'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Read a location back out of the index.
 *
 * Validated rather than cast: the column is written by this process today, but a row from an
 * older schema must degrade to "open the document, no location" instead of throwing and
 * taking the whole result page down with it.
 */
export function parseStoredLocation(json: string | null): DocumentLocation | null {
  if (json === null || json.length === 0) return null;
  try {
    const parsed = DocumentLocationSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Validated rather than cast, for the same reason as `parseStoredLocation`: a malformed id
 * degrades that one result to "not attached to a document" instead of throwing.
 */
function parseStoredDocumentId(value: string | null): DocumentId | null {
  if (value === null) return null;
  const parsed = DocumentIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class SearchService {
  constructor(private readonly db: WikiReaderDatabase) {}

  /**
   * Run a full-text query (criteria T07/T08/M10).
   *
   * An empty or operator-only query returns nothing rather than everything: FTS5 has no
   * "match all" expression, and silently degrading to a full table scan would make the
   * search box feel like it had ignored the input.
   */
  search(queryText: string, options: SearchOptions = {}): SearchResponse {
    const startedAt = performance.now();
    const parsed = parseQuery(queryText, {
      prefixLastTerm: options.prefixLastTerm ?? false,
    });

    if (parsed.isEmpty) {
      return { results: [], total: 0, normalizedQuery: '', durationMs: 0 };
    }

    const { clause, params } = this.buildFilterClause(options.filters);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const rows = this.db.sqlite
      .prepare(
        `SELECT e.entity_type, e.entity_id, e.document_id, e.location_json, e.title,
                snippet(search_fts, -1, ?, ?, ?, ?) AS snippet,
                bm25(search_fts, 8.0, 1.0, 2.0) AS score
           FROM search_fts
           JOIN search_entries e ON e.rowid = search_fts.rowid
          WHERE search_fts MATCH ?${clause}
          ORDER BY score
          LIMIT ? OFFSET ?`,
      )
      .all(
        SNIPPET_OPEN,
        SNIPPET_CLOSE,
        SNIPPET_ELLIPSIS,
        SNIPPET_TOKENS,
        parsed.expression,
        ...params,
        limit,
        offset,
      ) as SearchRow[];

    const totalRow = this.db.sqlite
      .prepare(
        `SELECT COUNT(*) AS n
           FROM search_fts
           JOIN search_entries e ON e.rowid = search_fts.rowid
          WHERE search_fts MATCH ?${clause}`,
      )
      .get(parsed.expression, ...params) as { n: number } | undefined;

    return {
      results: rows.map((row) => toSearchResult(row)),
      total: totalRow?.n ?? rows.length,
      normalizedQuery: parsed.expression,
      durationMs: performance.now() - startedAt,
    };
  }

  /** The FTS5 expression a query text would run as, without executing it. */
  explain(queryText: string, options: SearchOptions = {}): ParsedQuery {
    return parseQuery(queryText, { prefixLastTerm: options.prefixLastTerm ?? false });
  }

  /**
   * Filters are applied as SQL predicates rather than folded into the MATCH expression:
   * tags and collections live in their own tables, and an FTS5 column filter could not
   * express "document is in collection X" without denormalising it into the index.
   */
  private buildFilterClause(filters: SearchFilters | undefined): {
    clause: string;
    params: unknown[];
  } {
    if (filters === undefined) return { clause: '', params: [] };

    const clauses: string[] = [];
    const params: unknown[] = [];

    const { entityTypes, documentIds, tags, collectionIds, authors } = filters;

    if (entityTypes !== undefined && entityTypes.length > 0) {
      clauses.push(`e.entity_type IN (${entityTypes.map(() => '?').join(', ')})`);
      params.push(...entityTypes);
    }

    if (documentIds !== undefined && documentIds.length > 0) {
      clauses.push(`e.document_id IN (${documentIds.map(() => '?').join(', ')})`);
      params.push(...documentIds);
    }

    if (tags !== undefined && tags.length > 0) {
      clauses.push(
        `e.document_id IN (
           SELECT dt.document_id FROM document_tags dt
             JOIN tags t ON t.id = dt.tag_id
            WHERE t.name IN (${tags.map(() => '?').join(', ')}))`,
      );
      params.push(...tags);
    }

    if (collectionIds !== undefined && collectionIds.length > 0) {
      clauses.push(
        `e.document_id IN (
           SELECT dc.document_id FROM document_collections dc
            WHERE dc.collection_id IN (${collectionIds.map(() => '?').join(', ')}))`,
      );
      params.push(...collectionIds);
    }

    if (authors !== undefined && authors.length > 0) {
      const conditions = authors.map(() => 'd.authors_json LIKE ?').join(' OR ');
      clauses.push(`e.document_id IN (SELECT d.id FROM documents d WHERE ${conditions})`);
      params.push(...authors.map((author) => `%${author}%`));
    }

    if (filters.publishedAfter !== undefined) {
      clauses.push(
        'e.document_id IN (SELECT d.id FROM documents d WHERE d.published_date >= ?)',
      );
      params.push(filters.publishedAfter);
    }

    if (filters.publishedBefore !== undefined) {
      clauses.push(
        'e.document_id IN (SELECT d.id FROM documents d WHERE d.published_date <= ?)',
      );
      params.push(filters.publishedBefore);
    }

    return {
      clause: clauses.length === 0 ? '' : ` AND ${clauses.join(' AND ')}`,
      params,
    };
  }
}

function toSearchResult(row: SearchRow): SearchResult {
  const snippet = row.snippet;
  return {
    entityType: isEntityType(row.entity_type) ? row.entity_type : 'document',
    entityId: row.entity_id,
    documentId: parseStoredDocumentId(row.document_id),
    title: row.title,
    snippet,
    plainSnippet: stripSnippetMarkers(snippet),
    location: parseStoredLocation(row.location_json),
    // bm25 returns a negative number, better matches being more negative. Flip it so a
    // larger score is a better result, which is what every caller expects.
    score: -row.score,
  };
}
