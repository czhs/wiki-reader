/**
 * "Neither end of this edge has been deleted", as SQL.
 *
 * Deleting a highlight, a note or a document sets `deleted_at` and leaves both the row and its
 * edges in `links`, because a removal has to be recoverable (`B03`). Every view built *from*
 * the edges therefore has to say so: a query that mints its nodes from the link table keeps
 * drawing a node for something the researcher deleted, and a ledger that describes the far end
 * of an edge keeps reporting a highlight that is gone as a live connection.
 *
 * Written once, here, and imported by everything that asks the question — the graph traversal,
 * the wiki page, the focused view and the file's ledger. Two of those had a verbatim copy each
 * and one had none at all, which is exactly how two surfaces come to disagree about whether a
 * link is still there.
 *
 * Two spellings of the same predicate, because SQLite plans them very differently:
 *
 *   - `LIVE_EDGE` — `NOT EXISTS` per side. Right for a query already narrowed by an index to
 *     the edges touching one entity, where the number of rows tested is that entity's degree.
 *   - `DEAD_ENDPOINTS_CTE` + `liveEdgeByJoin` — the same three tables as a set, joined once.
 *     Right for a query that has to consider every link in the library: six correlated
 *     subqueries per row is what made the wiki page's ranking cost a second on a dense corpus,
 *     and a deleted row is rare enough that the set is almost always empty.
 */
import type { LinkableEntityType } from '@wr/shared-types';

/** The entity types whose rows are soft-deleted, with the table the row lives in. */
const SOFT_DELETED: ReadonlyArray<readonly [LinkableEntityType, string]> = [
  ['annotation', 'annotations'],
  ['note', 'notes'],
  ['document', 'documents'],
];

/** SQL for "this end of the edge has not been deleted", as a correlated existence check. */
export function liveEndpoint(side: 'source' | 'target', alias = 'l'): string {
  const branches = SOFT_DELETED.map(
    ([entityType, table]) =>
      `SELECT 1 FROM ${table} x
            WHERE ${alias}.${side}_type = '${entityType}' AND x.id = ${alias}.${side}_id
              AND x.deleted_at IS NOT NULL`,
  ).join('\n          UNION ALL\n          ');
  return `NOT EXISTS (\n          ${branches}\n        )`;
}

/** Both ends live, so a deleted entity neither appears nor pulls its neighbours in. */
export const LIVE_EDGE = `${liveEndpoint('source')} AND ${liveEndpoint('target')}`;

/**
 * Every deleted endpoint in the library, as a CTE body to put in a `WITH`.
 *
 * Small by nature: it holds what has been deleted, not what exists.
 */
export const DEAD_ENDPOINTS_CTE = `dead_endpoints AS (
    ${SOFT_DELETED.map(
      ([entityType, table]) =>
        `SELECT '${entityType}' AS entity_type, id AS entity_id
         FROM ${table} WHERE deleted_at IS NOT NULL`,
    ).join('\n    UNION ALL\n    ')}
  )`;

/**
 * The join half of the same predicate: `FROM links l ${joins}` … `WHERE ${where}`.
 *
 * Requires `DEAD_ENDPOINTS_CTE` in the statement's `WITH`.
 */
export const liveEdgeByJoin = (
  alias = 'l',
  suffix = '',
): { joins: string; where: string } => ({
  joins: `LEFT JOIN dead_endpoints dead_s${suffix}
            ON dead_s${suffix}.entity_type = ${alias}.source_type
           AND dead_s${suffix}.entity_id   = ${alias}.source_id
          LEFT JOIN dead_endpoints dead_t${suffix}
            ON dead_t${suffix}.entity_type = ${alias}.target_type
           AND dead_t${suffix}.entity_id   = ${alias}.target_id`,
  where: `dead_s${suffix}.entity_id IS NULL AND dead_t${suffix}.entity_id IS NULL`,
});
