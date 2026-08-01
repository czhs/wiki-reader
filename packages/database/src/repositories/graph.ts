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
import { DEAD_ENDPOINTS_CTE, LIVE_EDGE, liveEdgeByJoin } from './live-edge.js';

export interface OverviewOptions {
  /** Hard cap on nodes. No default: asking for all of it means saying how much you will take. */
  readonly nodeLimit: number;
  /**
   * Hard cap on edges, budgeted apart from the nodes and reported back the same way.
   *
   * Two hub files with four hundred links each are an ordinary shape for a working wiki, and
   * the lines between the drawn nodes are their own quantity: a map of three hundred discs can
   * carry twenty-five thousand of them, every one serialised over IPC and drawn as its own
   * element. A cap the answer confesses to (`elidedEdges`) is the only honest way to have one.
   */
  readonly edgeLimit: number;
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
 *
 * The frontier expansion, and nothing else. `overview` used to call this once per drawn node
 * and so let the cap decide, silently, which *lines* a complete-looking map had: two files with
 * more than four hundred links each were drawn with the link between them missing. Its edges
 * are one query over the drawn set now, capped by a number the answer reports.
 */
const EDGES_PER_NODE = 400;

/**
 * The kinds the wiki page draws, as SQL — and therefore the kinds its ranking counts.
 *
 * Files, notes, and the marked sentences the researcher has connected to something (`V01`).
 *
 * The containment edge is excluded, and that exclusion is the whole rule. Every highlight
 * carries an `annotation-belongs-to-document` edge to the paper it was made in, written
 * automatically when it was made; counting it would make a paper's degree its highlight count,
 * so a paper with fifty marked sentences and no links would be drawn as a hub with nothing
 * leading out of it — a lie about the corpus told in the one visual property the page has. And
 * it is what decides which highlights are on the map at all: `overview` admits an annotation
 * only where this predicate gives it a degree, which is exactly "something links it".
 *
 * It is also what keeps the page's redraw rule true rather than approximate. Making a highlight
 * cannot change this answer — the new row's only edge is the containment one — so the panel
 * still does not re-run a whole-library ranking for every marked sentence, and the link that
 * *does* put one on the map arrives as `library:changed` with reason `link`. See
 * `wiki-panel.tsx`.
 */
const CONTAINMENT_EDGE = `l.type <> 'annotation-belongs-to-document'`;
const DRAWN_KINDS =
  `l.source_type IN ('document', 'note', 'annotation')
   AND l.target_type IN ('document', 'note', 'annotation')
   AND ${CONTAINMENT_EDGE}`;

/**
 * How much of a marked sentence travels to the map (`V01`).
 *
 * Bounded here rather than in the view, because this answer can carry three hundred of them
 * over IPC. Two names for the same length, because they are read differently: the label the
 * page draws is shortened again to whatever fits under a disc, while the tooltip is read by
 * someone who has stopped on the node and wants the sentence.
 */
const TITLE_LIMIT = 120;
const SNIPPET_LIMIT = 120;

/** Whitespace collapsed and cut to a limit, the same shape `EntityResolver` uses. */
function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

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

/**
 * Neighbourhood queries over the typed-edge graph.
 *
 * The traversal runs *here*, in the main process, against SQLite — the renderer asks about one
 * seed with a radius and a node cap and gets back that subgraph and nothing else. Expansion is
 * index-driven and bounded at every step: one indexed lookup per frontier node, `EDGES_PER_NODE`
 * rows at most from each, and the depth bound decides how many rounds there are. The same is
 * true of `focus`, which is seeded on one file and reads the edges that touch it.
 *
 * `overview` is the exception and says so where it is written: the wiki page has no seed, so
 * ranking the library by degree means aggregating over `links` — and the fact that better-sqlite3
 * is synchronous makes the cost of that the whole main process's cost. It is one grouped pass
 * with the liveness test joined once rather than asked six ways per row, and the caller that
 * redraws is expected not to redraw for a change that cannot alter the picture.
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
   * A highlight is here once something links it (`V01`), and not before. Every highlight in the
   * library would be a picture of the annotations rather than of the corpus — that much of the
   * old rule stands — but a map with none of them drew two papers joined because a sentence in
   * one bears on a sentence in the other (`H02`) exactly like two papers that have never met.
   * `DRAWN_KINDS` is where the line is: the containment edge every highlight is born with does
   * not count, so "has a degree here" *is* "the researcher connected this sentence to
   * something". Where a highlight sits inside its paper is still the focused view's subject
   * (`F02`), and the edges are still only the ones that actually join two nodes on this map —
   * redrawing a highlight-to-highlight link as a line between their papers would be the view
   * inventing a row nobody wrote.
   *
   * Two queries and two budgets, for the same reason the focused view has two: the lines are
   * their own quantity. They are read once, over the drawn set, rather than once per drawn node
   * with a per-node cap — a cap that decided which lines existed while `truncated` and
   * `elidedNodes` spoke only about nodes, so a map with a link missing between two files it had
   * drawn presented itself as complete.
   *
   * Ranking is the one whole-table read in this class. `dead_endpoints` is joined once per side
   * instead of six correlated existence checks per row, and each half is grouped by the leading
   * columns of an index it can scan in order, which is what a pass over a dense corpus's `links`
   * costs when the process it blocks is the one that owns the database.
   */
  overview(options: OverviewOptions): GraphOverview {
    const live = liveEdgeByJoin('l', '_a');
    const liveTarget = liveEdgeByJoin('l', '_b');
    const ranked = this.db
      .prepare(
        `WITH ${DEAD_ENDPOINTS_CTE},
           -- Grouped by the leading columns of links_source_idx and links_target_idx, so each
           -- half is an ordered index scan that counts as it goes. Counting the two halves in
           -- one UNION ALL instead sorts every endpoint row in the library through a temp
           -- b-tree to answer the same question, and is three times slower for it.
           outgoing AS (
             SELECT l.source_type AS entity_type, l.source_id AS entity_id, COUNT(*) AS n
               FROM links l ${live.joins}
              WHERE ${live.where} AND ${DRAWN_KINDS}
              GROUP BY l.source_type, l.source_id
           ),
           incoming AS (
             SELECT l.target_type AS entity_type, l.target_id AS entity_id, COUNT(*) AS n
               FROM links l ${liveTarget.joins}
              WHERE ${liveTarget.where} AND ${DRAWN_KINDS}
              GROUP BY l.target_type, l.target_id
           ),
           degrees AS (
             SELECT entity_type, entity_id, SUM(n) AS degree
               FROM (SELECT entity_type, entity_id, n FROM outgoing
                     UNION ALL
                     SELECT entity_type, entity_id, n FROM incoming)
              GROUP BY entity_type, entity_id
           )
           ,
           -- Everything the map could draw, before the cap. A file or a note whether or not
           -- anybody has linked it — a wiki that showed only what was already connected would
           -- hide exactly the work left to do — and a highlight only where degrees gives it
           -- one, which by DRAWN_KINDS above means something links it (V01). The inner join
           -- is that rule: there is no COALESCE on this branch and there must not be.
           places AS (
             SELECT 'document' AS entity_type, d.id AS entity_id, d.title AS title,
                    NULL AS snippet, d.id AS document_id, COALESCE(g.degree, 0) AS degree
               FROM documents d
               LEFT JOIN degrees g ON g.entity_type = 'document' AND g.entity_id = d.id
              WHERE d.deleted_at IS NULL
             UNION ALL
             SELECT 'note', n.id, n.title, NULL, NULL, COALESCE(g.degree, 0)
               FROM notes n
               LEFT JOIN degrees g ON g.entity_type = 'note' AND g.entity_id = n.id
              WHERE n.deleted_at IS NULL
             UNION ALL
             SELECT 'annotation', a.id, a.selected_text, a.selected_text, a.document_id, g.degree
               FROM annotations a
               JOIN degrees g ON g.entity_type = 'annotation' AND g.entity_id = a.id
               JOIN documents d ON d.id = a.document_id AND d.deleted_at IS NULL
              WHERE a.deleted_at IS NULL
           )
         -- The count is a window over places, computed before the LIMIT — so how many the
         -- library holds and how many of them fit are one pass and cannot disagree.
         SELECT entity_type, entity_id, title, snippet, document_id, degree,
                COUNT(*) OVER () AS total
           FROM places
          ORDER BY degree DESC, title ASC, entity_id ASC
          LIMIT ?`,
      )
      .all(options.nodeLimit) as Array<{
      entity_type: LinkableEntityType;
      entity_id: string;
      title: string;
      snippet: string | null;
      document_id: string | null;
      degree: number;
      total: number;
    }>;

    const entityIds = ranked.map((row) => row.entity_id);
    const names = this.#displayNamesFor(entityIds);
    const icons = this.#iconsFor(entityIds);
    const drawn = new Set(ranked.map((row) => key(row.entity_type, row.entity_id)));

    // Both ends on the map, asked of the drawn set itself: every line between two nodes that
    // were sent, which is the same rule `createGraph` applies to a bounded neighbourhood and is
    // now the only thing that decides which lines exist.
    const { edges, totalEdges } = this.#edgesAmong(ranked, options.edgeLimit);

    const totalNodes = ranked[0]?.total ?? 0;
    return GraphOverviewSchema.parse({
      nodes: ranked.map((row) => {
        const icon = icons.get(key(row.entity_type, row.entity_id));
        // The paper a marked sentence was made in, when the paper is itself on the map. The
        // same rule the neighbourhood follows (`G06`): a container nobody was sent is no
        // container, because the view cannot draw a highlight beside a paper it has not got.
        const parent =
          row.entity_type === 'annotation' &&
          row.document_id !== null &&
          drawn.has(key('document', row.document_id))
            ? { entityType: 'document' as const, entityId: row.document_id }
            : null;
        return {
          entityType: row.entity_type,
          entityId: row.entity_id,
          // A highlight is titled by what it says — there is nothing shorter to call it — and
          // carries the same words again as its snippet, because the two are read differently:
          // the title is the node's tooltip and its accessible name, the snippet is what the
          // map draws so a marked sentence is not mistaken for a file (`V01`).
          title: row.snippet === null ? row.title : truncate(row.title, TITLE_LIMIT),
          snippet: row.snippet === null ? null : truncate(row.snippet, SNIPPET_LIMIT),
          displayName: names.get(key(row.entity_type, row.entity_id)) ?? null,
          iconFileId: icon === undefined ? null : DocumentFileIdSchema.parse(icon),
          documentId: row.document_id,
          parent,
          degree: row.degree,
        };
      }),
      edges: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      totalNodes,
      elidedNodes: Math.max(0, totalNodes - ranked.length),
      totalEdges,
      elidedEdges: Math.max(0, totalEdges - edges.size),
      truncated: totalNodes > ranked.length || totalEdges > edges.size,
    });
  }

  /**
   * Every live link with both ends inside one drawn set, oldest first, capped — and how many
   * there were in all.
   *
   * The drawn keys go into an indexed temp table rather than a `VALUES` list, and that is not a
   * style choice: SQLite materialises a `VALUES` CTE without an index, so the second join —
   * "is the far end also on the map" — becomes a scan of three hundred rows *per candidate
   * edge*. Measured on a thousand files and two hundred thousand links, the same question is
   * 1,200 ms that way and 40 ms this way.
   *
   * The count is asked separately, of the same predicate, because a cap the answer cannot
   * describe is a map that lies about being whole.
   */
  #edgesAmong(
    drawn: ReadonlyArray<{ entity_type: LinkableEntityType; entity_id: string }>,
    edgeLimit: number,
  ): { edges: Map<string, GraphEdge>; totalEdges: number } {
    const edges = new Map<string, GraphEdge>();
    if (drawn.length === 0) return { edges, totalEdges: 0 };

    this.db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS graph_drawn (
         entity_type TEXT NOT NULL,
         entity_id   TEXT NOT NULL,
         PRIMARY KEY (entity_type, entity_id)
       ) WITHOUT ROWID`,
    );
    this.db.exec('DELETE FROM temp.graph_drawn');
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO temp.graph_drawn (entity_type, entity_id) VALUES (?, ?)',
    );
    this.db.transaction(() => {
      for (const row of drawn) insert.run(row.entity_type, row.entity_id);
    })();

    const live = liveEdgeByJoin('l', '_e');
    const from = `FROM temp.graph_drawn s
           JOIN links l ON l.source_type = s.entity_type AND l.source_id = s.entity_id
           JOIN temp.graph_drawn t ON t.entity_type = l.target_type AND t.entity_id = l.target_id
           ${live.joins}
          WHERE ${live.where}`;

    const counted = this.db
      .prepare(`WITH ${DEAD_ENDPOINTS_CTE} SELECT COUNT(*) AS n ${from}`)
      .get() as { n: number } | undefined;

    const rows = this.db
      .prepare(
        `WITH ${DEAD_ENDPOINTS_CTE}
         SELECT ${LINK_COLUMNS} ${from}
          ORDER BY l.created_at, l.id
          LIMIT ?`,
      )
      .all(edgeLimit) as LinkRow[];

    for (const raw of rows) {
      const link = toLink(raw);
      edges.set(link.id, toGraphEdge(link));
    }
    return { edges, totalEdges: counted?.n ?? edges.size };
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
    // Reading order: where each highlight sits in the page, not when it was made. The page and
    // the offset into it are both columns beside the anchor (migration 013), so the order is
    // the order the page reads for a saved page and a markdown file as much as for a PDF —
    // `page_index` alone is `NULL` for two of the three, which left the ring in creation order
    // with a random tiebreak, reordering itself between two runs of the same query.
    const annotationIds = (
      this.db
        .prepare(
          `SELECT a.id AS id FROM annotations a
             JOIN annotation_anchors an ON an.annotation_id = a.id
            WHERE a.document_id = ? AND a.deleted_at IS NULL
            ORDER BY an.page_index, an.text_start, a.created_at, a.id
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
    //
    // Grouped in SQL, one row per file reached, and no ceiling on the edges considered. A
    // ceiling here would be a ceiling on which files appear — and one that `elidedNeighbours`,
    // counted from what survived it, could not see: three thousand connected files came back as
    // "sixteen drawn, 1,984 more", a thousand of them gone with nothing said. The work is
    // proportional to this file's own degree, which is the thing being asked about.
    //
    // Notes, notebooks and anything else at the far end are not *files*: the focused view crawls
    // between the things it can focus on next, and a node it cannot land on would be an edge
    // that goes nowhere. They are still on the wiki page and in the neighbourhood. The join to
    // `documents` also drops a file that was removed from the library, which is what the graph's
    // liveness rule says everywhere else.
    const reached = this.db
      .prepare(
        `WITH mine AS (
             SELECT id FROM annotations WHERE document_id = @documentId AND deleted_at IS NULL
           ),
           touching AS (
             SELECT l.source_type AS source_type, l.source_id AS source_id,
                    l.target_type AS target_type, l.target_id AS target_id,
                    sa.document_id AS source_document_id,
                    ta.document_id AS target_document_id
               FROM links l
               LEFT JOIN annotations sa
                      ON l.source_type = 'annotation' AND sa.id = l.source_id
               LEFT JOIN annotations ta
                      ON l.target_type = 'annotation' AND ta.id = l.target_id
              WHERE (
                    (l.source_type = 'document'   AND l.source_id = @documentId)
                 OR (l.target_type = 'document'   AND l.target_id = @documentId)
                 OR (l.source_type = 'annotation' AND l.source_id IN (SELECT id FROM mine))
                 OR (l.target_type = 'annotation' AND l.target_id IN (SELECT id FROM mine))
                  )
                AND ${LIVE_EDGE}
           ),
           sided AS (
             SELECT CASE
                      WHEN (source_type = 'document'   AND source_id = @documentId)
                        OR (source_type = 'annotation' AND source_document_id = @documentId)
                      THEN CASE target_type
                             WHEN 'document'   THEN target_id
                             WHEN 'annotation' THEN target_document_id
                           END
                      ELSE CASE source_type
                             WHEN 'document'   THEN source_id
                             WHEN 'annotation' THEN source_document_id
                           END
                    END AS far,
                    CASE WHEN source_type = 'document' AND target_type = 'document'
                         THEN 1 ELSE 0 END AS direct
               FROM touching
           )
         SELECT d.id AS document_id, d.title AS title,
                COUNT(*) AS connections, MAX(sided.direct) AS direct
           FROM sided
           JOIN documents d ON d.id = sided.far AND d.deleted_at IS NULL
          WHERE sided.far IS NOT NULL AND sided.far <> @documentId
          GROUP BY d.id, d.title
          ORDER BY connections DESC, d.title ASC, d.id ASC`,
      )
      .all({ documentId: options.documentId }) as Array<{
      document_id: string;
      title: string;
      connections: number;
      direct: number;
    }>;

    const kept = reached.slice(0, options.neighbourLimit);
    const keptIds = kept.map((row) => row.document_id);
    const neighbourNames = this.#displayNamesFor(keptIds);
    const neighbourIcons = this.#iconsFor(keptIds);

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
      neighbours: kept.map((row) => {
        const icon = neighbourIcons.get(key('document', row.document_id));
        return {
          documentId: row.document_id,
          title: row.title,
          displayName: neighbourNames.get(key('document', row.document_id)) ?? null,
          iconFileId: icon === undefined ? null : DocumentFileIdSchema.parse(icon),
          degree: this.degree('document', row.document_id),
          connections: row.connections,
          throughAnnotation: row.direct === 0,
        };
      }),
      elidedAnnotations: Math.max(0, (annotationTotal?.n ?? 0) - annotations.length),
      elidedNeighbours: Math.max(0, reached.length - kept.length),
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
