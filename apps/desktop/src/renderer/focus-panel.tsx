/**
 * The focused view: one file, what it says, and where it leads (criteria F02, F03).
 *
 * This is how a human crawls a library. The file is in the middle; the sentences marked in it
 * are around it, close in, because what a paper *says* is the reason to be looking at it; and
 * the files it reaches are at the border, because that is what they are — the way out. Choosing
 * one of them does not open a second view. It re-seats this one (`F03`), so a session is a
 * walk through the library rather than a pile of tabs.
 *
 * Deliberately a different surface from the neighbourhood panel and from the wiki page. The
 * neighbourhood panel answers "what is within N hops of this", which is a question about the
 * graph; this answers "what is this file, and where does it go next", which is a question about
 * reading. One view trying to be both would have to choose whose layout wins, and the two halves
 * here — the highlights and the connected files — have their own budgets precisely so that
 * neither can crowd the other out.
 *
 * It asks `graph:focus` and nothing else. Re-seating goes through the command registry, like
 * every other way a panel changes what the workspace is showing.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { createGraph, focusPositions, groupBoxes } from '@wr/graph';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { DocumentIdSchema, type GraphFocus } from '@wr/shared-types';
import { COMMAND_IDS, type PanelDescriptor } from '@wr/workbench';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';
import { SceneNode, VIEW_HEIGHT, VIEW_WIDTH, useSceneView } from './graph-canvas.js';

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

const keyOf = (entityType: string, entityId: string): string => `${entityType} ${entityId}`;

interface FocusPanelBodyProps {
  readonly documentId: string;
}

export function FocusPanelBody({ documentId }: FocusPanelBodyProps): JSX.Element {
  const { store, run, workbench } = useWorkspace();
  const [focused, setFocused] = useState<GraphFocus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const scene = useSceneView();
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
      void run(COMMAND_IDS.openFocusView, {
        entityId: nextDocumentId,
        entityType: 'document',
        documentId: nextDocumentId,
        mode: 'current',
      });
    },
    [run],
  );

  /** Open what a node stands for, through the workbench like every other navigation. */
  const open = useCallback(
    (entityType: 'document' | 'annotation', entityId: string) => {
      // No `documentId` on the ref: a highlight is resolved to the paper it was made in by the
      // host, from the annotation itself, so passing one here would be a second answer to a
      // question that already has one.
      void workbench.navigate({ entityId, entityType }, 'side').catch((failure: unknown) => {
        store.setStatus(describeError(failure).message, 'error');
      });
    },
    [store, workbench],
  );

  // The model and the arrangement, rebuilt only when the answer changes. The highlights are
  // Cytoscape's children of the file, which is what puts a box round the middle of the view:
  // containment is a fact the query answered, not one this panel inferred from a short edge.
  const laidOut = useMemo(() => {
    if (focused === null) return null;
    const centreId = keyOf('document', focused.focus.documentId);
    const innerIds = focused.annotations.map((annotation) =>
      keyOf('annotation', annotation.entityId),
    );
    const outerIds = focused.neighbours.map((neighbour) =>
      keyOf('document', neighbour.documentId),
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
    return { centreId, positions, groups: groupBoxes(model, positions), model };
  }, [focused]);

  if (error !== null) return <ErrorState message={error} testId="focus-panel-error" />;
  if (focused === null && loading) {
    return <EmptyState message="Reading the file…" testId="focus-panel-loading" />;
  }
  if (focused === null || laidOut === null) {
    return <EmptyState message="Nothing to focus on." testId="focus-panel-empty" />;
  }

  const { centreId, positions, groups } = laidOut;
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
        {(focused.elidedAnnotations > 0 || focused.elidedNeighbours > 0) && (
          <span className="wr-graph__elided" data-testid="focus-elision">
            {focused.elidedAnnotations + focused.elidedNeighbours} more not shown
          </span>
        )}
      </header>
      <div className="wr-graph__settings" data-testid="focus-settings">
        <button
          type="button"
          data-testid="focus-open-file"
          onClick={() => {
            open('document', focused.focus.documentId);
          }}
        >
          Open this file
        </button>
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
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
        preserveAspectRatio="xMidYMid meet"
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
        <g
          data-testid="focus-viewport"
          data-pan-x={String(scene.view.x)}
          data-pan-y={String(scene.view.y)}
          data-zoom={String(scene.view.zoom)}
          transform={`translate(${String(scene.view.x)} ${String(scene.view.y)}) scale(${String(
            scene.view.zoom,
          )})`}
        >
          {/* The file and what it says, boxed together and drawn under everything: the middle
              of the view is one thing, and the files at the edge are outside it. */}
          {box !== undefined && (
            <rect
              className="wr-graph__group-box"
              data-testid={`focus-group-${focused.focus.documentId}`}
              data-x={String(Math.round(box.x))}
              data-y={String(Math.round(box.y))}
              data-width={String(Math.round(box.width))}
              data-height={String(Math.round(box.height))}
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={20}
            />
          )}
          {[...focused.annotations, ...focused.neighbours].map((entry) => {
            const isAnnotation = 'entityId' in entry;
            const id = isAnnotation
              ? keyOf('annotation', entry.entityId)
              : keyOf('document', entry.documentId);
            const at = positions.get(id);
            if (at === undefined || centre === undefined) return null;
            return (
              <line
                key={`line-${id}`}
                className="wr-graph__edge"
                data-testid={`focus-edge-${isAnnotation ? entry.entityId : entry.documentId}`}
                data-relation={isAnnotation ? 'holds' : 'reaches'}
                x1={centre.x}
                y1={centre.y}
                x2={at.x}
                y2={at.y}
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
              clipPathId={`${clipId}-focus`}
              action="open"
              data={{ role: 'focus', degree: String(focused.focus.degree) }}
              onActivate={() => {
                open('document', focused.focus.documentId);
              }}
            />
          )}
          {focused.annotations.map((annotation) => {
            const at = positions.get(keyOf('annotation', annotation.entityId));
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
                clipPathId={`${clipId}-annotation`}
                action="open"
                data={{ role: 'annotation', degree: String(annotation.degree) }}
                onActivate={() => {
                  open('annotation', annotation.entityId);
                }}
              />
            );
          })}
          {focused.neighbours.map((neighbour) => {
            const at = positions.get(keyOf('document', neighbour.documentId));
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
              />
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export function focusDescriptorFrom(descriptor: PanelDescriptor | null): string | null {
  if (descriptor === null || descriptor.kind !== 'focus') return null;
  return descriptor.documentId;
}

export function FocusPanel({ params }: IDockviewPanelProps<{ panelId: string }>): JSX.Element {
  const state = useWorkspaceState();
  // Read from the descriptor rather than from panel state, because the descriptor is what the
  // crawl changes: the command re-seats the panel and this is how the change arrives.
  const documentId = focusDescriptorFrom(state.panels[params.panelId] ?? null);
  if (documentId === null) {
    return (
      <EmptyState
        message="Open a file, then open the focused view on it."
        testId="focus-panel-empty"
      />
    );
  }
  return <FocusPanelBody documentId={documentId} />;
}
