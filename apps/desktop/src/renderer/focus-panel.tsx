/**
 * The wiki, focused on one file: what it says, and where it leads (criteria F02, F03, F05).
 *
 * This is how a human crawls a library. The file is in the middle; the sentences marked in it
 * are around it, close in, because what a paper *says* is the reason to be looking at it; and
 * the files it reaches are at the border, because that is what they are — the way out. Choosing
 * one of them does not open a second view. It re-seats this one (`F03`), so a session is a
 * walk through the library rather than a pile of tabs.
 *
 * **This is a state of the wiki, not a panel of its own** (`F05`). `WikiPanel` draws this body
 * when its descriptor carries a file and `WikiPanelBody` when it does not, so the whole library
 * and one file in the middle of it are one tab in two states. They stay two very different
 * *layouts* — the neighbourhood panel answers "what is within N hops of this", the whole wiki
 * answers "everything, ranked", and this answers "what is this file, and where does it go next"
 * — and the two halves here, the highlights and the connected files, keep their own budgets
 * precisely so that neither can crowd the other out. What was wrong was making them two tabs.
 *
 * It asks `graph:focus` and nothing else. Re-seating and going back to the whole library both
 * go through the command registry, like every other way a panel changes what it is showing.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { createGraph, focusPositions, groupBoxes } from '@wr/graph';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { DocumentIdSchema, type GraphFocus } from '@wr/shared-types';
import { COMMAND_IDS } from '@wr/workbench';
import { useGraphNodeMenu } from './context-menu.js';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace } from './workspace.js';
import {
  SceneEdge,
  SceneFilter,
  SceneGroupBox,
  SceneNode,
  SceneViewportGroup,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  filterNeedle,
  matchesNeedle,
  sceneCanvasProps,
  sceneKey,
  usePanToMatches,
  useSceneView,
} from './graph-canvas.js';

/** The file in the middle, its highlights, and the files at the edge. */
const FOCUS_RADIUS = 18;
const ANNOTATION_RADIUS = 10;
const NEIGHBOUR_RADIUS = 13;

/**
 * How much of each half the view asks for.
 *
 * Two numbers, not one, and that is the whole point of the channel's shape: a paper with fifty
 * highlights still shows where it leads, and a paper in a dense corpus still shows what it says.
 * Both are below the contract's ceiling, because a view somebody reads has to stay readable.
 */
const ANNOTATION_LIMIT = 24;
const NEIGHBOUR_LIMIT = 16;

/**
 * Using the focused view to *choose* one end of a link rather than to read (`H04`).
 *
 * The milestone says this is the view's main use, and it needs nothing new to serve it: the
 * file in the middle and the sentences round it are already the two things a link can point
 * at, already drawn, already named. So picking is a third meaning for a click on the same
 * nodes — `data-action="pick"` — and the crawl at the edge is kept, because the way to reach
 * another paper's highlights is the way it always was.
 */
export interface FocusPicking {
  readonly onPick: (entityType: 'document' | 'annotation', entityId: string) => void;
  /** Where a file at the edge leads. The picker keeps its own focus rather than re-seating a panel. */
  readonly onRefocus: (documentId: string) => void;
  /** `<type> <id>` of the end already chosen, so the view can show which one it is. */
  readonly chosenKey?: string | null;
}

interface FocusPanelBodyProps {
  readonly documentId: string;
  readonly picking?: FocusPicking | undefined;
}

export function FocusPanelBody({ documentId, picking }: FocusPanelBodyProps): JSX.Element {
  const { store, run, workbench } = useWorkspace();
  const [focused, setFocused] = useState<GraphFocus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [query, setQuery] = useState('');
  // The file this view is seated on is what the scene is of, so a crawl onto another file
  // starts from the resting viewport instead of wherever the last file was left (`F03`).
  const scene = useSceneView(documentId);
  const clipId = useId();

  const load = useCallback((): Promise<void> => {
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (!parsed.success) {
      setError(`Not a file the focused view can open on: ${documentId}`);
      setLoading(false);
      return Promise.resolve();
    }
    setLoading(true);
    return call('graph:focus', {
      documentId: parsed.data,
      annotationLimit: ANNOTATION_LIMIT,
      neighbourLimit: NEIGHBOUR_LIMIT,
    })
      .then((answer) => {
        setFocused(answer);
        setError(null);
      })
      .catch((failure: unknown) => {
        setError(describeError(failure).message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [documentId]);

  useEffect(() => {
    void load();
    // A highlight made while this is open belongs in the middle of it without reopening the
    // panel; `library:changed` carries `annotation` as one of its reasons.
    return subscribe('library:changed', () => {
      void load();
    });
  }, [load]);

  /**
   * Move the view onto another file (`F03`).
   *
   * Through the command registry rather than by writing this panel's own descriptor: the same
   * thing has to happen when the focused view is opened on a file from the reader, the palette
   * or the activity bar, and one of those routes quietly not re-seating the view is exactly the
   * bug this arrangement exists to make impossible. The command resolves to a reveal that
   * carries the new descriptor, and this panel re-renders from it.
   */
  const refocus = useCallback(
    (nextDocumentId: string) => {
      if (picking !== undefined) {
        picking.onRefocus(nextDocumentId);
        return;
      }
      void run(COMMAND_IDS.openFocusView, {
        entityId: nextDocumentId,
        entityType: 'document',
        documentId: nextDocumentId,
        mode: 'current',
      });
    },
    [picking, run],
  );

  /** Open what a node stands for, through the workbench like every other navigation. */
  const open = useCallback(
    (entityType: 'document' | 'annotation', entityId: string) => {
      if (picking !== undefined) {
        picking.onPick(entityType, entityId);
        return;
      }
      // No `documentId` on the ref: a highlight is resolved to the paper it was made in by the
      // host, from the annotation itself, so passing one here would be a second answer to a
      // question that already has one.
      void workbench.navigate({ entityId, entityType }, 'side').catch((failure: unknown) => {
        store.setStatus(describeError(failure).message, 'error');
      });
    },
    [picking, store, workbench],
  );

  /** A node here offers what a node offers anywhere else on the map (`R01`). */
  const nodeMenu = useGraphNodeMenu();

  // The model and the arrangement, rebuilt only when the answer changes. The highlights are
  // Cytoscape's children of the file, which is what puts a box round the middle of the view:
  // containment is a fact the query answered, not one this panel inferred from a short edge.
  const laidOut = useMemo(() => {
    if (focused === null) return null;
    const centreId = sceneKey('document', focused.focus.documentId);
    const innerIds = focused.annotations.map((annotation) =>
      sceneKey('annotation', annotation.entityId),
    );
    const outerIds = focused.neighbours.map((neighbour) =>
      sceneKey('document', neighbour.documentId),
    );
    const model = createGraph(
      [
        { id: centreId },
        ...innerIds.map((id) => ({ id, parent: centreId })),
        ...outerIds.map((id) => ({ id })),
      ],
      // The lines are what the view is claiming: this sentence is in this paper, and this paper
      // leads to that one. Both are facts the answer carried; neither is drawn from a link row
      // this panel invented.
      [
        ...innerIds.map((id) => ({ id: `holds ${id}`, source: centreId, target: id })),
        ...outerIds.map((id) => ({ id: `reaches ${id}`, source: centreId, target: id })),
      ],
    );
    const positions = focusPositions(
      { centreId, innerIds, outerIds },
      { width: VIEW_WIDTH, height: VIEW_HEIGHT },
    );
    return { centreId, positions, groups: groupBoxes(model, positions) };
  }, [focused]);

  /**
   * Find, on the surface a dense paper is actually crawled on (`V02`).
   *
   * The criterion says "the graph", and the guide says `Find` is on every graph surface — this
   * one had the same discs, the same viewport group and no filter, so the sentence the guide
   * printed was false on the third of three. It matters most here: `ANNOTATION_LIMIT` is
   * twenty-four marked sentences round one paper, which is exactly the density a filter is for,
   * and the neighbours at the edge are the only list of where the file leads.
   *
   * The middle is deliberately matchable too. A crawl lands on a paper whose title the
   * researcher half-remembers, and "did I get to the right one" is a question the centre disc
   * should be able to answer.
   */
  const needle = filterNeedle(query);
  const matched = useMemo(() => {
    const found = new Set<string>();
    if (focused === null || needle === '') return found;
    if (matchesNeedle(needle, focused.focus.displayName, focused.focus.title)) {
      found.add(sceneKey('document', focused.focus.documentId));
    }
    for (const annotation of focused.annotations) {
      if (matchesNeedle(needle, annotation.displayName, annotation.title, annotation.excerpt)) {
        found.add(sceneKey('annotation', annotation.entityId));
      }
    }
    for (const neighbour of focused.neighbours) {
      if (matchesNeedle(needle, neighbour.displayName, neighbour.title)) {
        found.add(sceneKey('document', neighbour.documentId));
      }
    }
    return found;
  }, [focused, needle]);

  usePanToMatches(matched, laidOut?.positions ?? null, scene.panTo);

  if (error !== null) return <ErrorState message={error} testId="focus-panel-error" />;
  if (focused === null && loading) {
    return <EmptyState message="Reading the file…" testId="focus-panel-loading" />;
  }
  if (focused === null || laidOut === null) {
    return <EmptyState message="Nothing to focus on." testId="focus-panel-empty" />;
  }

  const { centreId, positions, groups } = laidOut;
  // What a click on the middle of the view means. The files at the edge always crawl.
  const nodeAction = picking === undefined ? 'open' : 'pick';
  const chosen = picking?.chosenKey ?? null;
  const centre = positions.get(centreId);
  const box = groups.get(centreId);
  const centreLabel = focused.focus.displayName ?? focused.focus.title;

  return (
    <div
      className="wr-graph"
      data-testid="focus-panel"
      data-focus-id={focused.focus.documentId}
      data-annotation-count={String(focused.annotations.length)}
      data-neighbour-count={String(focused.neighbours.length)}
      data-elided-annotations={String(focused.elidedAnnotations)}
      data-elided-neighbours={String(focused.elidedNeighbours)}
    >
      <header className="wr-graph__header">
        <span className="wr-graph__title" data-testid="focus-title">
          {centreLabel}
        </span>
        <span className="wr-graph__elided" data-testid="focus-counts">
          {focused.annotations.length === 1
            ? '1 highlight'
            : `${String(focused.annotations.length)} highlights`}
          {' · '}
          {focused.neighbours.length === 1
            ? '1 connected file'
            : `${String(focused.neighbours.length)} connected files`}
        </span>
        {/* Separately, because that is the whole point of the channel's two budgets: a sum
            says something was left out without saying whether it was what the paper says or
            where it leads, and neither half can be read back out of it. */}
        {focused.elidedAnnotations > 0 && (
          <span className="wr-graph__elided" data-testid="focus-elision">
            {focused.elidedAnnotations} more highlights not shown
          </span>
        )}
        {focused.elidedNeighbours > 0 && (
          <span className="wr-graph__elided" data-testid="focus-neighbour-elision">
            {focused.elidedNeighbours} more connected files not shown
          </span>
        )}
      </header>
      <div className="wr-graph__settings" data-testid="focus-settings">
        <SceneFilter
          testIdPrefix="focus"
          query={query}
          onQuery={setQuery}
          matches={matched.size}
          total={1 + focused.annotations.length + focused.neighbours.length}
        />
        <button
          type="button"
          data-testid="focus-open-file"
          onClick={() => {
            open('document', focused.focus.documentId);
          }}
        >
          {picking === undefined ? 'Open this file' : 'Link to this file'}
        </button>
        {/*
          The way back out of the focused state, on the surface it is a state of (`F05`).
          Through `openWiki` rather than by writing this panel's own descriptor, for the reason
          the crawl below goes through `openFocusView`: the whole library has to arrive the same
          way whether it was asked for here, from the activity bar or from a key, and one of
          those routes quietly doing something else is the bug the command registry prevents.
        */}
        {picking === undefined && (
          <button
            type="button"
            data-testid="wiki-whole"
            title="Back to the whole library on this same page"
            onClick={() => {
              void run(COMMAND_IDS.openWiki, { mode: 'current' });
            }}
          >
            The whole wiki
          </button>
        )}
        <label className="wr-graph__setting">
          <input
            data-testid="focus-setting-labels"
            type="checkbox"
            checked={showLabels}
            onChange={(event) => {
              setShowLabels(event.target.checked);
            }}
          />
          <span>Labels</span>
        </label>
        <button
          type="button"
          className="wr-graph__reset"
          data-testid="focus-view-reset"
          onClick={scene.reset}
        >
          Reset view
        </button>
      </div>
      <svg
        className="wr-graph__canvas"
        data-testid="focus-canvas"
        {...sceneCanvasProps(scene.canvas)}
        role="group"
        aria-label={`${centreLabel}, its highlights, and the files it connects to`}
        {...scene.svgProps}
      >
        <defs>
          <clipPath id={`${clipId}-focus`} clipPathUnits="userSpaceOnUse">
            <circle r={FOCUS_RADIUS} />
          </clipPath>
          <clipPath id={`${clipId}-annotation`} clipPathUnits="userSpaceOnUse">
            <circle r={ANNOTATION_RADIUS} />
          </clipPath>
          <clipPath id={`${clipId}-neighbour`} clipPathUnits="userSpaceOnUse">
            <circle r={NEIGHBOUR_RADIUS} />
          </clipPath>
        </defs>
        <SceneViewportGroup testId="focus-viewport" view={scene.view} fit={scene.canvas.fit}>
          {/* The file and what it says, boxed together and drawn under everything: the middle
              of the view is one thing, and the files at the edge are outside it. */}
          {box !== undefined && (
            <SceneGroupBox
              testId={`focus-group-${focused.focus.documentId}`}
              box={box}
              radius={20}
            />
          )}
          {[...focused.annotations, ...focused.neighbours].map((entry) => {
            const isAnnotation = 'entityId' in entry;
            const id = isAnnotation
              ? sceneKey('annotation', entry.entityId)
              : sceneKey('document', entry.documentId);
            const at = positions.get(id);
            if (at === undefined || centre === undefined) return null;
            return (
              <SceneEdge
                key={`line-${id}`}
                testId={`focus-edge-${isAnnotation ? entry.entityId : entry.documentId}`}
                from={centre}
                to={at}
                // A line is lit when either end is. Every line here has the middle at one end,
                // so a filter that matched only the centre would light all of them — which is
                // why the centre is not counted as "either end" while something else matches.
                lit={needle === '' || matched.has(id)}
                // What only this view knows: whether the far end is a sentence this paper
                // holds or a paper it reaches.
                data={{ relation: isAnnotation ? 'holds' : 'reaches' }}
              />
            );
          })}
          {centre !== undefined && (
            <SceneNode
              testIdPrefix="focus-node"
              entityType="document"
              entityId={focused.focus.documentId}
              title={focused.focus.title}
              displayName={focused.focus.displayName}
              iconFileId={focused.focus.iconFileId}
              x={centre.x}
              y={centre.y}
              radius={FOCUS_RADIUS}
              primary
              showLabel={showLabels}
              matches={
                needle === '' || matched.has(sceneKey('document', focused.focus.documentId))
              }
              clipPathId={`${clipId}-focus`}
              action={nodeAction}
              data={{
                role: 'focus',
                degree: String(focused.focus.degree),
                chosen: chosen === sceneKey('document', focused.focus.documentId) ? 'true' : 'false',
              }}
              onActivate={() => {
                open('document', focused.focus.documentId);
              }}
              onContextMenu={(event) => {
                nodeMenu(event, {
                  entityType: 'document',
                  entityId: focused.focus.documentId,
                  documentId: focused.focus.documentId,
                });
              }}
            />
          )}
          {focused.annotations.map((annotation) => {
            const at = positions.get(sceneKey('annotation', annotation.entityId));
            if (at === undefined) return null;
            return (
              <SceneNode
                key={annotation.entityId}
                testIdPrefix="focus-node"
                entityType="annotation"
                entityId={annotation.entityId}
                // The highlight's own words. A ring of discs labelled "Highlight" would be a
                // count of what the paper says rather than what it says.
                title={annotation.excerpt === '' ? annotation.title : annotation.excerpt}
                displayName={annotation.displayName}
                iconFileId={annotation.iconFileId}
                x={at.x}
                y={at.y}
                radius={ANNOTATION_RADIUS}
                showLabel={showLabels}
                matches={
                  needle === '' || matched.has(sceneKey('annotation', annotation.entityId))
                }
                clipPathId={`${clipId}-annotation`}
                action={nodeAction}
                data={{
                  role: 'annotation',
                  degree: String(annotation.degree),
                  chosen: chosen === sceneKey('annotation', annotation.entityId) ? 'true' : 'false',
                }}
                onActivate={() => {
                  open('annotation', annotation.entityId);
                }}
                // The paper it was marked in, so the ledger and the focused view on this menu
                // are about a file rather than about nothing.
                onContextMenu={(event) => {
                  nodeMenu(event, {
                    entityType: 'annotation',
                    entityId: annotation.entityId,
                    documentId: focused.focus.documentId,
                  });
                }}
              />
            );
          })}
          {focused.neighbours.map((neighbour) => {
            const at = positions.get(sceneKey('document', neighbour.documentId));
            if (at === undefined) return null;
            return (
              <SceneNode
                key={neighbour.documentId}
                testIdPrefix="focus-node"
                entityType="document"
                entityId={neighbour.documentId}
                title={neighbour.title}
                displayName={neighbour.displayName}
                iconFileId={neighbour.iconFileId}
                x={at.x}
                y={at.y}
                radius={NEIGHBOUR_RADIUS}
                showLabel={showLabels}
                matches={
                  needle === '' || matched.has(sceneKey('document', neighbour.documentId))
                }
                clipPathId={`${clipId}-neighbour`}
                // The crawl. A file at the edge is somewhere to go, so choosing it moves the
                // view onto it rather than opening a reader on top of the view being read.
                action="refocus"
                data={{
                  role: 'neighbour',
                  degree: String(neighbour.degree),
                  connections: String(neighbour.connections),
                  'through-annotation': neighbour.throughAnnotation ? 'true' : 'false',
                }}
                onActivate={() => {
                  refocus(neighbour.documentId);
                }}
                onContextMenu={(event) => {
                  nodeMenu(event, {
                    entityType: 'document',
                    entityId: neighbour.documentId,
                    documentId: neighbour.documentId,
                  });
                }}
              />
            );
          })}
        </SceneViewportGroup>
      </svg>
    </div>
  );
}
