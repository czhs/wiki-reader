import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import { boundedNeighbourhood, createGraph } from '@wr/graph';
import {
  DocumentFileIdSchema,
  GraphFocusSchema,
  GraphNeighbourhoodSchema,
  GraphOverviewSchema,
  type GraphEdge,
  type GraphFocus,
  type GraphNeighbourhood,
  type GraphNode,
  type GraphOverview,
  type LinkableEntityType,
} from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { EntityResolver } from '../entity-resolver.js';
import { toLink, type LinkRow } from '../mappers.js';

export interface OverviewOptions {
  /** Hard cap on nodes. No default: asking for all of it means saying how much you will take. */
  readonly nodeLimit: number;
}

export interface FocusOptions {
  readonly documentId: string;
  /** Hard cap on the file's own highlights. */
  readonly annotationLimit: number;
  /** Hard cap on the files it reaches, budgeted apart from the highlights. */
  readonly neighbourLimit: number;
}

export interface NeighbourhoodOptions {
  readonly seedType: LinkableEntityType;
  readonly seedId: string;
  /** Hops from the seed. */
  readonly depth: number;
  /** Hard cap on nodes, seed included. */
  readonly nodeLimit: number;
}

/**
 * Edges read per node while the frontier expands.
 *
 * A hub with thousands of edges must not turn one level of expansion into a full scan of
 * `links`. The cap is well above `nodeLimit`, so the node cap — the one the caller chose and
 * that gets reported back — is what actually decides the answer in every normal case.
 */
const EDGES_PER_NODE = 400;

/**
 * Edges read for one focused view, across the file and every highlight in it.
 *
 * One query rather than one per highlight, so a heavily marked-up paper costs a single indexed
 * read. The bound is well above what any two caps could show, so it is a ceiling on the work
 * and never the thing that decides which files appear — that is `neighbourLimit`, which is
 * reported back as an elision.
 */
const FOCUS_EDGE_LIMIT = 2_000;

const key = (entityType: string, entityId: string): string => `${entityType}\u0000${entityId}`;

function fromKey(value: string): { entityType: LinkableEntityType; entityId: string } {
  const separator = value.indexOf('\u0000');
  return {
    entityType: value.slice(0, separator) as LinkableEntityType,
    entityId: value.slice(separator + 1),
  };
}

/**
 * A link row as the graph draws it.
 *
 * Deliberately narrower than `Link`: the locations, the ordinal, the generator, the metadata
 * and the timestamps are not on the wire, because a line between two discs cannot show them
 * and every field that crosses is one a panel could come to depend on. Written once, so the
 * neighbourhood and the wiki page cannot disagree about what an edge is.
 */
const toGraphEdge = (link: ReturnType<typeof toLink>): GraphEdge => ({
  id: link.id,
  type: link.type,
  sourceType: link.sourceType,
  sourceId: link.sourceId,
  targetType: link.targetType,
  targetId: link.targetId,
  origin: link.origin,
  label: link.label,
});

const LINK_COLUMNS = `l.id, l.type, l.source_type, l.source_id, l.target_type, l.target_id,
  l.source_location_json, l.target_location_json, l.label, l.ordinal, l.origin, l.generator,
  l.metadata_json, l.created_at, l.updated_at`;

/** The entity types whose rows are soft-deleted, with the table the row lives in. */
const SOFT_DELETED: ReadonlyArray<readonly [LinkableEntityType, string]> = [
  ['annotation', 'annotations'],
  ['note', 'notes'],
  ['document', 'documents'],
];

/**
 * SQL for "this end of the edge has not been deleted".
 *
 * Deleting a highlight sets `annotations.deleted_at` and leaves both the row and its edges in
 * `links`. The traversal below mints its nodes *from the edges*, so an edge that outlives its
 * endpoint keeps drawing a node for something the user deleted. The filter belongs here, in the
 * query, and not in the view: `graph:neighbourhood` has more than one consumer and a
 * renderer-side filter would leave the stale node in every other one.
 */
function liveEndpoint(side: 'source' | 'target'): string {
  const branches = SOFT_DELETED.map(
    ([entityType, table]) =>
      `SELECT 1 FROM ${table} x
            WHERE l.${side}_type = '${entityType}' AND x.id = l.${side}_id
              AND x.deleted_at IS NOT NULL`,
  ).join('\n          UNION ALL\n          ');
  return `NOT EXISTS (\n          ${branches}\n        )`;
}

/** Both ends live, so a deleted entity neither appears nor pulls its neighbours in. */
const LIVE_EDGE = `${liveEndpoint('source')} AND ${liveEndpoint('target')}`;

/**
 * Neighbourhood queries over the typed-edge graph.
 *
 * The traversal runs *here*, in the main process, against SQLite — the renderer asks about one
 * seed with a radius and a node cap and gets back that subgraph and nothing else. Expansion is
 * index-driven and bounded at every step: one indexed lookup per frontier node, `EDGES_PER_NODE`
 * rows at most from each, and the depth bound decides how many rounds there are. There is no
 * code path here that reads `links` whole.
 *
 * The bounding itself is `@wr/graph`, the same module the renderer lays the result out with, so
 * "within N hops" means one thing in both processes.
 */
export class GraphRepository {
  private readonly resolver: EntityResolver;
  /** Compiled on first use, kept for the life of the connection. See `#edgesTouching`. */
  #touching: Statement | undefined;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {
    this.resolver = new EntityResolver(db);
  }

  /**
   * Name a node — here, in the graph, and nowhere else.
   *
   * Deliberately not a write to `documents.title`. That field is Zotero's, refreshed from the
   * item on the next import, so a display name written through it reverts silently and the
   * researcher is given no reason to think it would (`G03`). Passing `null` removes the name
   * and the node goes back to being labelled with whatever it is called.
   */
  setDisplayName(
    entityType: LinkableEntityType,
    entityId: string,
    displayName: string | null,
  ): string | null {
    if (displayName === null) {
      this.db
        .prepare('DELETE FROM graph_node_names WHERE entity_type = ? AND entity_id = ?')
        .run(entityType, entityId);
      return null;
    }
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO graph_node_names (entity_type, entity_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET display_name = excluded.display_name,
                                                           updated_at = excluded.updated_at`,
      )
      .run(entityType, entityId, displayName, now, now);
    return displayName;
  }

  displayName(entityType: LinkableEntityType, entityId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT display_name FROM graph_node_names WHERE entity_type = ? AND entity_id = ?',
      )
      .get(entityType, entityId) as { display_name: string } | undefined;
    return row?.display_name ?? null;
  }

  /**
   * Illustrate a node with a file the library already holds (`G04`).
   *
   * A file id and never a path: `rrfile://<file id>` is the only image reference the renderer
   * can be given, and the caller is expected to have checked that the id names an image before
   * getting here. `null` takes the picture away.
   */
  setIcon(
    entityType: LinkableEntityType,
    entityId: string,
    fileId: string | null,
  ): string | null {
    if (fileId === null) {
      this.db
        .prepare('DELETE FROM graph_node_icons WHERE entity_type = ? AND entity_id = ?')
        .run(entityType, entityId);
      return null;
    }
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO graph_node_icons (entity_type, entity_id, file_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET file_id    = excluded.file_id,
                                                           updated_at = excluded.updated_at`,
      )
      .run(entityType, entityId, fileId, now, now);
    return fileId;
  }

  icon(entityType: LinkableEntityType, entityId: string): string | null {
    const row = this.db
      .prepare('SELECT file_id FROM graph_node_icons WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) as { file_id: string } | undefined;
    return row?.file_id ?? null;
  }

  /**
   * The names for one bounded set of nodes.
   *
   * Read by id rather than as a whole table, so the query stays bounded by the node cap the
   * caller already chose — the same rule the traversal above follows.
   */
  #displayNamesFor(ids: readonly string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT entity_type, entity_id, display_name FROM graph_node_names
          WHERE entity_id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids) as Array<{ entity_type: string; entity_id: string; display_name: string }>;
    return new Map(rows.map((row) => [key(row.entity_type, row.entity_id), row.display_name]));
  }

  /**
   * The live links touching one entity, newest last, capped.
   *
   * One statement, prepared on first use and reused after: better-sqlite3 caches the compiled
   * plan on the statement object, and this runs once per node of a frontier expansion. Both
   * the neighbourhood and the whole-library overview ask exactly this question, and had a
   * verbatim copy each — two places for the liveness clause to be got right.
   */
  #edgesTouching(entityType: string, entityId: string): LinkRow[] {
    this.#touching ??= this.db.prepare(
      `SELECT ${LINK_COLUMNS} FROM links l
        WHERE ((l.source_type = ? AND l.source_id = ?)
           OR (l.target_type = ? AND l.target_id = ?))
          AND ${LIVE_EDGE}
        ORDER BY l.created_at, l.id
        LIMIT ?`,
    );
    return this.#touching.all(
      entityType,
      entityId,
      entityType,
      entityId,
      EDGES_PER_NODE,
    ) as LinkRow[];
  }

  /** The icons for one bounded set of nodes, read by id for the same reason the names are. */
  #iconsFor(ids: readonly string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT entity_type, entity_id, file_id FROM graph_node_icons
          WHERE entity_id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids) as Array<{ entity_type: string; entity_id: string; file_id: string }>;
    return new Map(rows.map((row) => [key(row.entity_type, row.entity_id), row.file_id]));
  }

  neighbourhood(options: NeighbourhoodOptions): GraphNeighbourhood {
    const seedKey = key(options.seedType, options.seedId);
    const described = this.resolver.describe(options.seedType, options.seedId);


    // --- bounded frontier expansion ---------------------------------------
    const nodeKeys = new Set<string>([seedKey]);
    const edges = new Map<string, GraphEdge>();
    let frontier: string[] = [seedKey];

    for (let hop = 0; hop < options.depth; hop += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        const { entityType, entityId } = fromKey(current);
        const rows = this.#edgesTouching(entityType, entityId);
        for (const row of rows) {
          const link = toLink(row);
          edges.set(link.id, toGraphEdge(link));
          for (const endpoint of [
            key(link.sourceType, link.sourceId),
            key(link.targetType, link.targetId),
          ]) {
            if (nodeKeys.has(endpoint)) continue;
            nodeKeys.add(endpoint);
            next.push(endpoint);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }

    // --- bound it with the shared model -----------------------------------
    const graph = createGraph(
      [...nodeKeys].map((id) => ({ id })),
      [...edges.values()].map((edge) => ({
        id: edge.id,
        source: key(edge.sourceType, edge.sourceId),
        target: key(edge.targetType, edge.targetId),
      })),
    );
    const bounded = boundedNeighbourhood(graph, {
      seedId: seedKey,
      depth: options.depth,
      nodeLimit: options.nodeLimit,
    });

    const entityIds = bounded.nodeIds.map((id) => fromKey(id).entityId);
    const names = this.#displayNamesFor(entityIds);
    const icons = this.#iconsFor(entityIds);
    const drawn = new Set(bounded.nodeIds);
    const nodes: GraphNode[] = bounded.nodeIds.map((id) => {
      const { entityType, entityId } = fromKey(id);
      const entity = this.resolver.describe(entityType, entityId);
      const icon = icons.get(id);
      // The document a highlight was made in, when that document is itself on screen. The
      // resolver already answers this for every entity that lives inside a document, so
      // containment is read off the same description the title comes from rather than being a
      // second traversal that could disagree with it. A document is not its own container, and
      // a container the node cap dropped is not one either: the view can only draw a box round
      // something it was sent (`G06`).
      const containerId = entity?.documentId ?? null;
      const parent =
        containerId !== null &&
        key('document', containerId) !== id &&
        drawn.has(key('document', containerId))
          ? { entityType: 'document' as const, entityId: containerId }
          : null;
      return {
        entityType,
        entityId,
        // A node whose row is gone is still a fact about the graph — an edge points at it —
        // so it is shown as unresolved rather than dropped, which would hide the dangling
        // link that caused it.
        title: entity?.title ?? entityId,
        // Both are sent. The view draws the name and the panel still knows what the thing is
        // actually called, so a renamed node can say so rather than pretending.
        displayName: names.get(id) ?? null,
        // A file id, so the renderer can address the bytes over `rrfile://` without ever
        // being told where they are.
        iconFileId: icon === undefined ? null : DocumentFileIdSchema.parse(icon),
        documentId: entity?.documentId ?? null,
        parent,
        distance: bounded.distances.get(id) ?? 0,
        degree: this.degree(entityType, entityId),
      };
    });

    const keptEdges = bounded.edgeIds.flatMap((id) => {
      const edge = edges.get(id);
      return edge === undefined ? [] : [edge];
    });

    return GraphNeighbourhoodSchema.parse({
      seed: {
        entityType: options.seedType,
        entityId: options.seedId,
        title: described?.title ?? options.seedId,
      },
      depth: options.depth,
      nodes,
      edges: keptEdges,
      elidedNodes: bounded.elidedNodes,
      truncated: bounded.elidedNodes > 0,
    });
  }

  /**
   * The library as a place: every file and note, ranked, capped, and the edges between them.
   *
   * The only query here that is not seeded, which is why every other property has to be tighter.
   * The node list comes from `documents` and `notes` rather than from `links`, so a file nobody
   * has connected yet is still on the map — a wiki that only showed what was already linked
   * would hide exactly the work left to do. Ranking is by degree, so the cap keeps the busiest
   * files rather than an alphabetical slice, and `totalNodes` says how many there are so a
   * truncated map cannot read as the whole library.
   *
   * Highlights are deliberately absent. Where a highlight sits is the focused view's whole
   * subject (`F02`), and a corpus drawn with every highlight in it is a picture of the
   * annotations. For the same reason the edges are the ones that actually join two nodes on
   * this map: an edge between two highlights is a fact about those highlights, and redrawing it
   * as a line between their papers would be the view inventing a row nobody wrote.
   */
  overview(options: OverviewOptions): GraphOverview {
    const total = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL)
              + (SELECT COUNT(*) FROM notes     WHERE deleted_at IS NULL) AS n`,
      )
      .get() as { n: number } | undefined;

    const ranked = this.db
      .prepare(
        `WITH endpoints AS (
             SELECT l.source_type AS entity_type, l.source_id AS entity_id
               FROM links l WHERE ${LIVE_EDGE}
             UNION ALL
             SELECT l.target_type, l.target_id
               FROM links l WHERE ${LIVE_EDGE}
           ),
           degrees AS (
             SELECT entity_type, entity_id, COUNT(*) AS degree
               FROM endpoints GROUP BY entity_type, entity_id
           )
         SELECT 'document' AS entity_type, d.id AS entity_id, d.title AS title,
                COALESCE(g.degree, 0) AS degree
           FROM documents d
           LEFT JOIN degrees g ON g.entity_type = 'document' AND g.entity_id = d.id
          WHERE d.deleted_at IS NULL
         UNION ALL
         SELECT 'note', n.id, n.title, COALESCE(g.degree, 0)
           FROM notes n
           LEFT JOIN degrees g ON g.entity_type = 'note' AND g.entity_id = n.id
          WHERE n.deleted_at IS NULL
          ORDER BY degree DESC, title ASC, entity_id ASC
          LIMIT ?`,
      )
      .all(options.nodeLimit) as Array<{
      entity_type: LinkableEntityType;
      entity_id: string;
      title: string;
      degree: number;
    }>;

    const drawn = new Set(ranked.map((row) => key(row.entity_type, row.entity_id)));
    const entityIds = ranked.map((row) => row.entity_id);
    const names = this.#displayNamesFor(entityIds);
    const icons = this.#iconsFor(entityIds);

    const edges = new Map<string, GraphEdge>();
    for (const row of ranked) {
      const rows = this.#edgesTouching(row.entity_type, row.entity_id);
      for (const raw of rows) {
        const link = toLink(raw);
        // Both ends on the map, or the line would run off it to something nobody was sent —
        // the same rule `createGraph` applies to a bounded neighbourhood.
        if (
          !drawn.has(key(link.sourceType, link.sourceId)) ||
          !drawn.has(key(link.targetType, link.targetId))
        ) {
          continue;
        }
        edges.set(link.id, toGraphEdge(link));
      }
    }

    const totalNodes = total?.n ?? ranked.length;
    return GraphOverviewSchema.parse({
      nodes: ranked.map((row) => {
        const icon = icons.get(key(row.entity_type, row.entity_id));
        return {
          entityType: row.entity_type,
          entityId: row.entity_id,
          title: row.title,
          displayName: names.get(key(row.entity_type, row.entity_id)) ?? null,
          iconFileId: icon === undefined ? null : DocumentFileIdSchema.parse(icon),
          documentId: row.entity_type === 'document' ? row.entity_id : null,
          parent: null,
          degree: row.degree,
        };
      }),
      edges: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      totalNodes,
      elidedNodes: Math.max(0, totalNodes - ranked.length),
      truncated: totalNodes > ranked.length,
    });
  }

  /**
   * One file, what it says, and where it leads (`F02`, `F03`).
   *
   * Two budgets, filled by two queries, because the answer has two halves that must not compete:
   * the highlights come back in reading order — what the paper says, in the order it says it —
   * and the connected files come back by how strongly they are connected. Either half can be
   * elided without touching the other, and both say how much they left out.
   *
   * A connection counts whether it runs between the two files or between a highlight in one and
   * a highlight in the other, which is the shape a library grows into once highlights link to
   * highlights: the file at the edge is the one this reading actually leads to, however the edge
   * was written. `throughAnnotation` says which of the two it was, so the view can be honest
   * about a file that nothing joins directly.
   *
   * Returns `null` for a file that does not resolve; the caller reports that as not-found rather
   * than drawing an empty view of nothing.
   */
  focus(options: FocusOptions): GraphFocus | null {
    const described = this.resolver.describe('document', options.documentId);
    if (described === null) return null;

    // --- what it says ------------------------------------------------------
    // Reading order, the order the highlights were made in the page: a ring that reordered
    // itself as links were added would move the sentence someone was looking for.
    const annotationIds = (
      this.db
        .prepare(
          `SELECT a.id AS id FROM annotations a
             JOIN annotation_anchors an ON an.annotation_id = a.id
            WHERE a.document_id = ? AND a.deleted_at IS NULL
            ORDER BY an.page_index, a.created_at, a.id
            LIMIT ?`,
        )
        .all(options.documentId, options.annotationLimit) as Array<{ id: string }>
    ).map((row) => row.id);

    const annotationTotal = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM annotations WHERE document_id = ? AND deleted_at IS NULL',
      )
      .get(options.documentId) as { n: number } | undefined;

    const annotationNames = this.#displayNamesFor(annotationIds);
    const annotationIcons = this.#iconsFor(annotationIds);
    const annotations = annotationIds.flatMap((id) => {
      const entity = this.resolver.describe('annotation', id);
      if (entity === null) return [];
      const icon = annotationIcons.get(key('annotation', id));
      return [
        {
          entityId: id,
          title: entity.title,
          excerpt: entity.excerpt,
          location: entity.location,
          displayName: annotationNames.get(key('annotation', id)) ?? null,
          iconFileId: icon === undefined ? null : DocumentFileIdSchema.parse(icon),
          degree: this.degree('annotation', id),
        },
      ];
    });

    // --- where it leads ----------------------------------------------------
    const reaching = this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM links l
          WHERE (
                (l.source_type = 'document'   AND l.source_id = ?)
             OR (l.target_type = 'document'   AND l.target_id = ?)
             OR (l.source_type = 'annotation' AND l.source_id IN
                   (SELECT id FROM annotations WHERE document_id = ? AND deleted_at IS NULL))
             OR (l.target_type = 'annotation' AND l.target_id IN
                   (SELECT id FROM annotations WHERE document_id = ? AND deleted_at IS NULL))
              )
            AND ${LIVE_EDGE}
          ORDER BY l.created_at, l.id
          LIMIT ?`,
      )
      .all(
        options.documentId,
        options.documentId,
        options.documentId,
        options.documentId,
        FOCUS_EDGE_LIMIT,
      ) as LinkRow[];

    interface Reach {
      connections: number;
      direct: boolean;
    }
    const reached = new Map<string, Reach>();
    /** The file an endpoint belongs to: itself, or the paper a highlight was made in. */
    const fileOf = (entityType: LinkableEntityType, entityId: string): string | null => {
      if (entityType === 'document') return entityId;
      if (entityType !== 'annotation') return null;
      return this.resolver.describe('annotation', entityId)?.documentId ?? null;
    };

    for (const raw of reaching) {
      const link = toLink(raw);
      const source = fileOf(link.sourceType, link.sourceId);
      const target = fileOf(link.targetType, link.targetId);
      const far = source === options.documentId ? target : source;
      // Notes, notebooks and anything else at the far end are not *files*: the focused view
      // crawls between the things it can focus on next, and a node it cannot land on would be
      // an edge that goes nowhere. They are still on the wiki page and in the neighbourhood.
      if (far === null || far === options.documentId) continue;
      const direct = link.sourceType === 'document' && link.targetType === 'document';
      const existing = reached.get(far);
      if (existing === undefined) reached.set(far, { connections: 1, direct });
      else {
        existing.connections += 1;
        existing.direct = existing.direct || direct;
      }
    }

    const neighbourIds = [...reached.keys()];
    const neighbourTitles = new Map(
      neighbourIds.flatMap((id) => {
        const entity = this.resolver.describe('document', id);
        return entity === null ? [] : [[id, entity.title] as const];
      }),
    );
    const ranked = neighbourIds
      .filter((id) => neighbourTitles.has(id))
      .sort((a, b) => {
        const byConnections =
          (reached.get(b)?.connections ?? 0) - (reached.get(a)?.connections ?? 0);
        if (byConnections !== 0) return byConnections;
        const byTitle = (neighbourTitles.get(a) ?? '').localeCompare(neighbourTitles.get(b) ?? '');
        return byTitle !== 0 ? byTitle : a.localeCompare(b);
      });
    const kept = ranked.slice(0, options.neighbourLimit);
    const neighbourNames = this.#displayNamesFor(kept);
    const neighbourIcons = this.#iconsFor(kept);

    const focusIcon = this.#iconsFor([options.documentId]).get(key('document', options.documentId));
    return GraphFocusSchema.parse({
      focus: {
        documentId: options.documentId,
        title: described.title,
        displayName: this.displayName('document', options.documentId),
        iconFileId: focusIcon === undefined ? null : DocumentFileIdSchema.parse(focusIcon),
        degree: this.degree('document', options.documentId),
      },
      annotations,
      neighbours: kept.map((id) => {
        const reach = reached.get(id);
        const icon = neighbourIcons.get(key('document', id));
        return {
          documentId: id,
          title: neighbourTitles.get(id) ?? id,
          displayName: neighbourNames.get(key('document', id)) ?? null,
          iconFileId: icon === undefined ? null : DocumentFileIdSchema.parse(icon),
          degree: this.degree('document', id),
          connections: reach?.connections ?? 1,
          throughAnnotation: !(reach?.direct ?? false),
        };
      }),
      elidedAnnotations: Math.max(0, (annotationTotal?.n ?? 0) - annotations.length),
      elidedNeighbours: Math.max(0, ranked.length - kept.length),
    });
  }

  /**
   * Edges touching an entity in the whole database, not only inside this view.
   *
   * Same deletion filter as the traversal: the degree is what the view says a node continues
   * into, so counting edges to deleted entities would promise neighbours that can never be
   * expanded to.
   */
  private degree(entityType: LinkableEntityType, entityId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM links l
          WHERE ((l.source_type = ? AND l.source_id = ?)
             OR (l.target_type = ? AND l.target_id = ?))
            AND ${LIVE_EDGE}`,
      )
      .get(entityType, entityId, entityType, entityId) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
