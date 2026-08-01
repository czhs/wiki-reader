/**
 * The graph panel (criteria W09, W10, G01, G02).
 *
 * The renderer never holds the graph. It holds *a* graph: the bounded neighbourhood the main
 * process answered with, which arrives already capped by seed, radius and node count. This
 * module asks `graph:neighbourhood` and nothing else — there is no path here to the link
 * tables, because a panel that queried them directly would quietly undo that bound.
 *
 * Drawn as SVG rather than onto Cytoscape's canvas. Cytoscape holds the model and the
 * traversal — the same module the main process bounds the query with — and a node stays a
 * real element: focusable, keyboard-activatable, and nameable by a test. A canvas would make
 * "click the node for this document" a pixel calculation. The discs, the labels and the
 * pan/zoom gestures are `graph-canvas`, shared with the wiki page and the focused view.
 *
 * Pan, zoom and the drawing settings are persisted by the main process, not by the panel:
 * the panel's own state dies with its tab, and both `G01` and `G02` are about what is still
 * true after that tab is gone. Which one they are keyed by differs, and deliberately —
 * settings are one view of graphs in general, a viewport is where *this* seed's graph was
 * left.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { createGraph, groupBoxes, layoutPositions } from '@wr/graph';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import {
  LinkableEntityTypeSchema,
  type CardArtDisclosure,
  type CardArtGalleryEntry,
  type CardArtStatus,
  type GraphNeighbourhood,
  type GraphViewSettings,
  type GraphViewport,
  type LinkableEntityType,
} from '@wr/shared-types';
import { COMMAND_IDS, type PanelDescriptor } from '@wr/workbench';
import { useGraphNodeMenu } from './context-menu.js';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';
import {
  RESTING_VIEW,
  SceneEdge,
  SceneFilter,
  SceneGroupBox,
  SceneLinkLine,
  sceneCanvasProps,
  SceneNode,
  SceneViewportGroup,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  centredOn,
  filterNeedle,
  matchesNeedle,
  roundViewport,
  sceneKey,
  useSceneGestures,
  type SceneLinkDrag,
  type SceneLinking,
} from './graph-canvas.js';

/** How many nodes a neighbourhood view asks for. The contract caps it lower than it can go. */
const NODE_LIMIT = 60;

/**
 * How long a gesture settles before it is written.
 *
 * A wheel gesture is dozens of events; each one is a viewport. Writing every one would put a
 * transaction on the main process per animation frame for a value only the last of which is
 * ever read. Short enough that closing the tab straight after a gesture still saves it — and
 * unmount flushes whatever is still pending regardless.
 */
const SAVE_DELAY_MS = 150;

/** Radius of a node's disc, and of the picture clipped into it. */
const SEED_RADIUS = 16;
const NODE_RADIUS = 11;

/** How many of the library's images the icon picker offers. */
const ICON_CHOICE_LIMIT = 50;

interface GraphPanelBodyProps {
  readonly seedEntityId: string;
  readonly seedEntityType: string;
}

function GraphPanelBody({
  seedEntityId,
  seedEntityType,
}: GraphPanelBodyProps): JSX.Element {
  const { store, workbench, run } = useWorkspace();
  const [graph, setGraph] = useState<GraphNeighbourhood | null>(null);
  /** Bumped to re-ask after something the panel itself changed, like a node's name. */
  const [reload, setReload] = useState(0);
  const [settings, setSettings] = useState<GraphViewSettings | null>(null);
  const [viewport, setViewport] = useState<GraphViewport>(RESTING_VIEW);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  const seedType = useMemo((): LinkableEntityType | null => {
    const parsed = LinkableEntityTypeSchema.safeParse(seedEntityType);
    return parsed.success ? parsed.data : null;
  }, [seedEntityType]);

  // --- what was persisted about this view -----------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await call('graph:getView', {
          seedType,
          seedId: seedType === null ? null : seedEntityId,
        });
        if (cancelled) return;
        setSettings(view.settings);
        setViewport(view.viewport ?? RESTING_VIEW);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seedEntityId, seedType]);

  // --- the neighbourhood itself ---------------------------------------------
  const depth = settings?.depth ?? null;
  useEffect(() => {
    if (seedType === null) {
      setError(`Not something the graph can open on: ${seedEntityType}`);
      setLoading(false);
      return;
    }
    if (depth === null) return;

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const neighbourhood = await call('graph:neighbourhood', {
          seedType,
          seedId: seedEntityId,
          depth,
          nodeLimit: NODE_LIMIT,
        });
        if (cancelled) return;
        setGraph(neighbourhood);
        setError(null);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [depth, reload, seedEntityId, seedEntityType, seedType]);

  // --- persisting the viewport ----------------------------------------------
  // The pending value and the timer are refs rather than state: a gesture must not re-render
  // once per event just to remember that it still owes a write.
  const pending = useRef<GraphViewport | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const next = pending.current;
    pending.current = null;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (next === null || seedType === null) return;
    void call('graph:setViewport', {
      seedType,
      seedId: seedEntityId,
      viewport: next,
    }).catch(() => {
      // A viewport that failed to save is not worth interrupting reading for. The graph on
      // screen is unaffected; the next gesture tries again.
    });
  }, [seedEntityId, seedType]);

  // Flushed on unmount, so closing the tab immediately after a gesture still saves it —
  // which is exactly what `G01` closes the panel to check.
  useEffect(() => flush, [flush]);

  const moveView = useCallback(
    (next: GraphViewport) => {
      const rounded = roundViewport(next);
      setViewport(rounded);
      pending.current = rounded;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        flush();
      }, SAVE_DELAY_MS);
    },
    [flush],
  );

  // --- panning and zooming ----------------------------------------------------
  // The gestures themselves are `graph-canvas`'s, shared with the wiki page and the focused
  // view; what is this panel's own is where the resulting viewport goes — through `moveView`,
  // into the main process, keyed by the seed.
  //
  // And what is shared with them: two discs joined by dragging between them (`H09`), and a
  // line singled out and taken away (`H07`). A neighbourhood is where a wrong edge is most
  // visible — it is the picture of what this one file is connected to.
  const [linkDrag, setLinkDrag] = useState<SceneLinkDrag | null>(null);
  const [chosenEdge, setChosenEdge] = useState<string | null>(null);
  const linking = useMemo<SceneLinking>(
    () => ({
      onDrag: setLinkDrag,
      onLink: (from, to) => {
        void run(COMMAND_IDS.createDocumentLink, {
          sourceId: from.entityId,
          sourceType: from.entityType,
          targetId: to.entityId,
          targetType: to.entityType,
        });
      },
    }),
    [run],
  );
  const { svgProps, canvas, refit } = useSceneGestures(viewport, moveView, linking);
  // The viewport as it stands, readable from an effect that must not re-run for every pan.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // --- the drawing settings ---------------------------------------------------
  const changeSettings = useCallback(
    (patch: Partial<GraphViewSettings>) => {
      setSettings((current) => {
        if (current === null) return current;
        const next = { ...current, ...patch };
        void call('graph:setViewSettings', next).catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
        return next;
      });
    },
    [store],
  );

  // Cytoscape's model, built from what main sent, laid out by the same package that bounded
  // it. Rebuilt only when the neighbourhood or the spacing changes: a re-layout on every
  // render would move the graph under the pointer.
  const spacing = settings?.spacing ?? 1;
  const laidOut = useMemo(() => {
    if (graph === null) return null;
    const model = createGraph(
      // Containment as Cytoscape's own parentage — the model the main process sent, not a
      // grouping this panel decided on (`G06`).
      graph.nodes.map((node) => ({
        id: sceneKey(node.entityType, node.entityId),
        parent:
          node.parent === null ? null : sceneKey(node.parent.entityType, node.parent.entityId),
      })),
      graph.edges.map((edge) => ({
        id: edge.id,
        source: sceneKey(edge.sourceType, edge.sourceId),
        target: sceneKey(edge.targetType, edge.targetId),
      })),
    );
    const distances = new Map(
      graph.nodes.map((node) => [sceneKey(node.entityType, node.entityId), node.distance]),
    );
    const laid = layoutPositions(model, { width: VIEW_WIDTH, height: VIEW_HEIGHT }, distances);
    // Spacing pushes the rings apart from the centre rather than re-laying out, so raising it
    // spreads the same arrangement instead of producing a different one.
    const positions = new Map(
      [...laid.entries()].map(([id, at]) => [
        id,
        {
          x: VIEW_WIDTH / 2 + (at.x - VIEW_WIDTH / 2) * spacing,
          y: VIEW_HEIGHT / 2 + (at.y - VIEW_HEIGHT / 2) * spacing,
        },
      ]),
    );
    // After the spacing, never before: a box drawn round where the contents were going to be
    // is a box the contents have since moved out of.
    const groups = groupBoxes(model, positions);
    return { positions, groups };
  }, [graph, spacing]);

  /**
   * The neighbourhood searched in place (`V02`), on the same rule the wiki page uses.
   *
   * Two hops out of a busy paper is sixty discs, which is the density at which reading every
   * label to find one is the thing a person stops doing. Matching nodes stay where the layout
   * put them — the rings are how far out a node is, and that is the panel's whole subject — and
   * the view moves onto them, through `moveView`, so the pan is saved for this seed like any
   * other (`G01`).
   */
  const needle = filterNeedle(query);
  const matched = useMemo(() => {
    const found = new Set<string>();
    if (graph === null || laidOut === null || needle === '') return found;
    for (const node of graph.nodes) {
      if (matchesNeedle(needle, node.displayName, node.title)) {
        found.add(sceneKey(node.entityType, node.entityId));
      }
    }
    return found;
  }, [graph, laidOut, needle]);

  // A change detector, not a list: the keys are read from a ref, because a key is
  // `<type> <id>` and splitting a joined list of them back apart is a bug in waiting.
  const matchedRef = useRef(matched);
  matchedRef.current = matched;
  const destination = [...matched].sort().join('|');
  useEffect(() => {
    if (destination === '' || laidOut === null) return;
    const points = [...matchedRef.current].flatMap((id) => {
      const at = laidOut.positions.get(id);
      return at === undefined ? [] : [at];
    });
    const next = centredOn(points, viewportRef.current.zoom);
    if (next !== null) moveView(next);
    // Keyed on the answer alone: a redraw of the neighbourhood must not yank the view back to
    // a filter the researcher has since panned away from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, moveView]);

  // What the seed node is called here now, and the field that changes it. The field is a draft
  // rather than a live write: renaming on every keystroke would put a database write and a
  // re-query behind each letter.
  const seedDisplayName =
    graph?.nodes.find(
      (node) =>
        node.entityType === graph.seed.entityType && node.entityId === graph.seed.entityId,
    )?.displayName ?? null;
  const [nameDraft, setNameDraft] = useState('');
  useEffect(() => {
    setNameDraft(seedDisplayName ?? '');
  }, [seedDisplayName]);

  /**
   * Rename the node the graph is open on.
   *
   * The seed and not an arbitrary node, because the seed is the one the panel already knows
   * the reader is looking at — and because reaching any other node is one click away: opening
   * it and pressing Graph re-seeds on it. An empty field means "no name of its own", not a
   * node called nothing.
   */
  const rename = useCallback(
    (name: string) => {
      if (seedType === null) return;
      const trimmed = name.trim();
      void call('graph:setNodeName', {
        entityType: seedType,
        entityId: seedEntityId,
        displayName: trimmed === '' ? null : trimmed.slice(0, 120),
      })
        .then(() => {
          setReload((count) => count + 1);
        })
        .catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
    },
    [seedEntityId, seedType, store],
  );

  // --- the picture on the seed node -------------------------------------------
  // What the library holds that could go on a node. Re-asked when the library changes, so an
  // image dropped in while the graph is open is offered without reopening the panel.
  const [iconChoices, setIconChoices] = useState<readonly { fileId: string; title: string }[]>(
    [],
  );
  const loadChoices = useCallback(() => {
    void call('graph:iconChoices', { limit: ICON_CHOICE_LIMIT })
      .then((answer) => {
        setIconChoices(answer.choices);
      })
      .catch(() => {
        // A picker that could not be filled is an empty picker, not a broken graph.
      });
  }, []);
  useEffect(() => {
    loadChoices();
    return subscribe('library:changed', () => {
      loadChoices();
    });
  }, [loadChoices]);

  const seedIconFileId =
    graph?.nodes.find(
      (node) =>
        node.entityType === graph.seed.entityType && node.entityId === graph.seed.entityId,
    )?.iconFileId ?? null;

  /**
   * Put a picture on the node the graph is open on, or take it off.
   *
   * A file id chosen from what the library already holds — the renderer has no way to name a
   * file on the disk and this is not the place that changes it. Getting an image *into* the
   * library is a drop, which is handled in the preload and never crosses a channel.
   */
  const illustrate = useCallback(
    (fileId: string | null) => {
      if (seedType === null) return;
      void call('graph:setNodeIcon', { entityType: seedType, entityId: seedEntityId, fileId })
        .then(() => {
          setReload((count) => count + 1);
        })
        .catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
    },
    [seedEntityId, seedType, store],
  );

  // --- card art (criterion G05) -----------------------------------------------
  // The second exception to local-first, and the only control on this panel behind which a
  // request can leave the machine. Its state is read from the main process rather than kept
  // here, because "off" has to be a fact about the installation and not about this tab.
  const [cardArt, setCardArt] = useState<CardArtStatus | null>(null);
  const [disclosure, setDisclosure] = useState<CardArtDisclosure | null>(null);
  useEffect(() => {
    void call('cardArt:status', {})
      .then(setCardArt)
      .catch(() => {
        // A status that could not be read leaves the control unrendered, which is the same
        // thing it shows when the feature is off — the safe way round.
      });
  }, []);

  /**
   * Show what a fetch would send, before there is anything to press.
   *
   * The disclosure is fetched on demand rather than with the status, so opening a graph is not
   * two requests when the answer is nearly always "still off". Pressing this is the only way
   * the switch below it appears: the order on screen is the order of the decision, and the
   * main process refuses to enable without the acknowledgement in any case (`A03`'s rule).
   */
  const readDisclosure = useCallback(() => {
    void call('cardArt:disclosure', {})
      .then(setDisclosure)
      .catch((failure: unknown) => {
        store.setStatus(describeError(failure).message, 'error');
      });
  }, [store]);

  const switchCardArt = useCallback(
    (enabled: boolean) => {
      // The acknowledgement rides with the request that needs it, and only when turning it on.
      void call('cardArt:enable', { enabled, acknowledgeDisclosure: enabled })
        .then((next) => {
          setCardArt(next);
          if (!enabled) setDisclosure(null);
        })
        .catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
    },
    [store],
  );

  /**
   * The gallery the icon picker is (criterion `B06`).
   *
   * The control this replaced was a field that took a card's *name*, which is only usable by
   * someone who already knows several hundred of them — a picker you have to know the answer
   * to. A strip of illustrations you scroll through and press asks nothing. The pictures come
   * back as file ids and are drawn over `rrfile://`, exactly as a node's icon is: the renderer
   * never sees a URL, and one page is asked for at a time so opening the panel does not fetch
   * a set.
   */
  const [gallery, setGallery] = useState<CardArtGallery | null>(null);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const cardArtOn = cardArt?.enabled === true;

  const loadGallery = useCallback(
    (offset: number) => {
      setGalleryBusy(true);
      void call('cardArt:gallery', { offset, limit: GALLERY_PAGE })
        .then((page) => {
          setGallery((current) =>
            current === null || offset === 0
              ? { entries: page.entries, total: page.total, setName: page.setName }
              : {
                  ...current,
                  entries: [...current.entries, ...page.entries],
                  total: page.total,
                },
          );
        })
        .catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        })
        .finally(() => {
          setGalleryBusy(false);
        });
    },
    [store],
  );

  useEffect(() => {
    // Off is off: nothing is asked for until the switch has been thrown, and throwing it back
    // forgets the page rather than keeping a strip of pictures on a panel that cannot fetch.
    if (!cardArtOn) {
      setGallery(null);
      return;
    }
    loadGallery(0);
  }, [cardArtOn, loadGallery]);

  /**
   * Put the illustration a person pressed on the node the graph is open on.
   *
   * A name, still — the same channel the gallery's own pictures came through. The renderer has
   * no host and no URL — see the module header of `card-art.ts` — and this is the entire
   * vocabulary it has for asking. The bytes are already on this disk by the time a tile can be
   * pressed, so choosing one never leaves the machine.
   */
  const fetchArt = useCallback(
    (name: string) => {
      if (seedType === null) return;
      const trimmed = name.trim();
      if (trimmed === '') return;
      void call('cardArt:fetch', { entityType: seedType, entityId: seedEntityId, name: trimmed })
        .then((art) => {
          setReload((count) => count + 1);
          void call('cardArt:status', {}).then(setCardArt).catch(() => undefined);
          store.setStatus(
            art.fromCache ? 'That picture was already here.' : 'Picture fetched.',
            'info',
          );
        })
        .catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
    },
    [seedEntityId, seedType, store],
  );

  // Clip paths are addressed by id, and two graph panels share one document. `useId` keeps
  // the second panel from clipping against the first one's shapes.
  const clipId = useId();

  const open = useCallback(
    (entityType: string, entityId: string) => {
      const parsed = LinkableEntityTypeSchema.safeParse(entityType);
      if (!parsed.success) return;
      // Through the workbench, like every other way of opening something — the graph panel
      // never reaches into a reader panel. To the side, so the graph is still there to click
      // again: it is a way of getting around, not a dialog that closes behind you.
      void workbench.navigate({ entityId, entityType: parsed.data }, 'side').catch(
        (failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        },
      );
    },
    [store, workbench],
  );

  /** The same menu the wiki's discs carry: a node is a node wherever it is drawn (`R01`). */
  const nodeMenu = useGraphNodeMenu();

  if (error !== null) return <ErrorState message={error} testId="graph-panel-error" />;
  // Only the settings are worth waiting on: they decide what is asked for. Once a graph has
  // arrived it stays on screen through the next query, so changing a setting adjusts the view
  // rather than blanking it and drawing a second one.
  if (settings === null || (graph === null && loading)) {
    return <EmptyState message="Reading the graph…" testId="graph-panel-loading" />;
  }
  if (graph === null || laidOut === null) {
    return <EmptyState message="Nothing to graph." testId="graph-panel-empty" />;
  }

  const { positions, groups } = laidOut;
  const seedKey = sceneKey(graph.seed.entityType, graph.seed.entityId);
  /**
   * Which container a node is drawn in — its own, if it is one.
   *
   * A document holding highlights *is* the group, so an edge into it is an edge into that
   * group and one leaving it crosses out. Nodes with no container answer with the empty
   * string, which is what an edge between two ungrouped nodes reports on both ends.
   */
  const groupOf = (entityType: string, entityId: string): string => {
    const key = sceneKey(entityType, entityId);
    if (groups.has(key)) return key;
    const node = graph.nodes.find(
      (entry) => entry.entityType === entityType && entry.entityId === entityId,
    );
    return node?.parent === undefined || node.parent === null
      ? ''
      : sceneKey(node.parent.entityType, node.parent.entityId);
  };

  return (
    <div
      className="wr-graph"
      data-testid="graph-panel"
      data-seed-id={graph.seed.entityId}
      data-node-count={String(graph.nodes.length)}
      data-edge-count={String(graph.edges.length)}
      data-depth={String(settings.depth)}
      data-spacing={String(settings.spacing)}
      data-labels={settings.showLabels ? 'on' : 'off'}
    >
      <header className="wr-graph__header">
        <span className="wr-graph__title">
          {graph.seed.title} · {graph.depth === 1 ? '1 hop' : `${String(graph.depth)} hops`}
        </span>
        {graph.truncated && (
          <span className="wr-graph__elided" data-testid="graph-elision">
            {graph.elidedNodes} more not shown
          </span>
        )}
      </header>
      <div className="wr-graph__settings" data-testid="graph-settings">
        <label className="wr-graph__setting">
          <span>Name</span>
          <input
            data-testid="graph-node-name"
            data-control="graph.rename"
            className="wr-graph__name"
            type="text"
            maxLength={120}
            // The document's own title, so an empty field reads as "called what it is called"
            // rather than as a name that has been lost.
            placeholder={graph.seed.title}
            value={nameDraft}
            onChange={(event) => {
              setNameDraft(event.target.value);
            }}
            onBlur={() => {
              if (nameDraft !== (seedDisplayName ?? '')) rename(nameDraft);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                rename(nameDraft);
              }
            }}
          />
        </label>
        <label className="wr-graph__setting">
          <span>Icon</span>
          <select
            data-testid="graph-node-icon"
            data-control="graph.picture"
            value={seedIconFileId ?? ''}
            onChange={(event) => {
              illustrate(event.target.value === '' ? null : event.target.value);
            }}
          >
            <option value="">No picture</option>
            {/* An icon set from a bigger library than the picker offers is still what the node
                wears; listing it keeps the control honest rather than showing "No picture". */}
            {seedIconFileId !== null &&
              !iconChoices.some((choice) => choice.fileId === seedIconFileId) && (
                <option value={seedIconFileId}>The picture it has</option>
              )}
            {iconChoices.map((choice) => (
              <option key={choice.fileId} value={choice.fileId}>
                {choice.title}
              </option>
            ))}
          </select>
        </label>
        {cardArt !== null && (
          <CardArt
            status={cardArt}
            disclosure={disclosure}
            gallery={gallery}
            busy={galleryBusy}
            onRead={readDisclosure}
            onSwitch={switchCardArt}
            onMore={loadGallery}
            onChoose={fetchArt}
          />
        )}
        <label className="wr-graph__setting">
          <span>Hops</span>
          <select
            data-testid="graph-setting-depth"
            data-control="graph.hops"
            value={String(settings.depth)}
            onChange={(event) => {
              changeSettings({ depth: Number(event.target.value) });
            }}
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <label className="wr-graph__setting">
          <span>Spacing</span>
          <input
            data-testid="graph-setting-spacing"
            data-control="graph.spacing"
            type="range"
            min="0.5"
            max="2.5"
            step="0.25"
            value={String(settings.spacing)}
            onChange={(event) => {
              changeSettings({ spacing: Number(event.target.value) });
            }}
          />
        </label>
        <SceneFilter
          testIdPrefix="graph"
          query={query}
          onQuery={setQuery}
          matches={matched.size}
          total={graph.nodes.length}
        />
        <label className="wr-graph__setting">
          <input
            data-testid="graph-setting-labels"
            data-control="graph.labels"
            type="checkbox"
            checked={settings.showLabels}
            onChange={(event) => {
              changeSettings({ showLabels: event.target.checked });
            }}
          />
          <span>Labels</span>
        </label>
        <button
          type="button"
          className="wr-graph__reset"
          data-testid="graph-view-reset"
          data-control="graph.reset"
          onClick={() => {
            moveView(RESTING_VIEW);
            // And the fit with it: the resting view is the map as it would be drawn if this
            // panel were opened at the size it is now (`F04`).
            refit();
          }}
        >
          Reset view
        </button>
      </div>
      <svg
        className="wr-graph__canvas"
        data-testid="graph-canvas"
        // Press a disc, drag to another, let go (`H09`). No button to hang the id on.
        data-control="link.dragNodes"
        data-linking={linkDrag === null ? 'false' : 'true'}
        {...sceneCanvasProps(canvas)}
        role="group"
        aria-label={`Links around ${graph.seed.title}`}
        {...svgProps}
      >
        {/* A picture is clipped to the disc it sits on, so an image of any shape reads as a
            node rather than as a rectangle floating over the graph. */}
        <defs>
          <clipPath id={`${clipId}-seed`} clipPathUnits="userSpaceOnUse">
            <circle r={SEED_RADIUS} />
          </clipPath>
          <clipPath id={`${clipId}-node`} clipPathUnits="userSpaceOnUse">
            <circle r={NODE_RADIUS} />
          </clipPath>
        </defs>
        <SceneViewportGroup testId="graph-viewport" view={viewport} fit={canvas.fit}>
          {/* The containers, underneath everything: a document's highlights are drawn inside
              the paper they were made in rather than at the ring their hop count would put
              them on, and the box says so (`G06`). Behind the edges, so a line crossing out of
              a group is drawn over the boundary it crosses. */}
          {[...groups.entries()].map(([key, box]) => {
            const held = graph.nodes.find(
              (node) => sceneKey(node.entityType, node.entityId) === key,
            );
            if (held === undefined) return null;
            return (
              <g key={`group-${key}`} className="wr-graph__group">
                <SceneGroupBox
                  testId={`graph-group-${held.entityId}`}
                  box={box}
                  radius={18}
                  data={{ 'entity-type': held.entityType }}
                />
              </g>
            );
          })}
          {graph.edges.map((edge) => {
            const from = positions.get(sceneKey(edge.sourceType, edge.sourceId));
            const to = positions.get(sceneKey(edge.targetType, edge.targetId));
            if (from === undefined || to === undefined) return null;
            const fromGroup = groupOf(edge.sourceType, edge.sourceId);
            const toGroup = groupOf(edge.targetType, edge.targetId);
            return (
              <SceneEdge
                key={edge.id}
                testId={`graph-edge-${edge.id}`}
                linkType={edge.type}
                from={from}
                to={to}
                lit={
                  needle === '' ||
                  matched.has(sceneKey(edge.sourceType, edge.sourceId)) ||
                  matched.has(sceneKey(edge.targetType, edge.targetId))
                }
                // Which container each end sits in, so an edge between two papers is legible as
                // one that runs between groups and not merely between two discs.
                data={{
                  'source-group': fromGroup,
                  'target-group': toGroup,
                  'crosses-groups':
                    fromGroup !== toGroup && (fromGroup !== '' || toGroup !== '')
                      ? 'true'
                      : 'false',
                }}
                // Taken away from the picture of what this file is connected to (`H07`).
                chosen={chosenEdge === edge.id}
                onChoose={() => {
                  setChosenEdge((now) => (now === edge.id ? null : edge.id));
                }}
                onDelete={() => {
                  setChosenEdge(null);
                  void run(COMMAND_IDS.deleteLink, { linkId: edge.id });
                }}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const key = sceneKey(node.entityType, node.entityId);
            const position = positions.get(key);
            if (position === undefined) return null;
            const isSeed = key === seedKey;
            return (
              <SceneNode
                key={key}
                testIdPrefix="graph-node"
                entityType={node.entityType}
                entityId={node.entityId}
                title={node.title}
                displayName={node.displayName}
                iconFileId={node.iconFileId}
                x={position.x}
                y={position.y}
                radius={isSeed ? SEED_RADIUS : NODE_RADIUS}
                primary={isSeed}
                showLabel={settings.showLabels}
                matches={needle === '' || matched.has(key)}
                clipPathId={`${clipId}-${isSeed ? 'seed' : 'node'}`}
                action="open"
                // What only a neighbourhood knows: how far out the node is, how busy it is, and
                // the container it is drawn in — empty for a node standing on its own (`G06`).
                data={{
                  'parent-id': node.parent?.entityId ?? '',
                  distance: String(node.distance),
                  degree: String(node.degree),
                }}
                onActivate={() => {
                  open(node.entityType, node.entityId);
                }}
                onContextMenu={(event) => {
                  nodeMenu(event, node);
                }}
              />
            );
          })}
        </SceneViewportGroup>
        {/* Over the scene rather than in it: both ends are already in the canvas's own units. */}
        <SceneLinkLine testId="graph-link-drag" fit={canvas.fit} drag={linkDrag} />
      </svg>
    </div>
  );
}

/**
 * A page of the gallery, as this panel holds it.
 *
 * Accumulated rather than replaced: pressing More appends, so scrolling back up shows what was
 * already there instead of a strip that jumps to the newest page.
 */
interface CardArtGallery {
  readonly entries: readonly CardArtGalleryEntry[];
  readonly total: number;
  readonly setName: string;
}

/** How many illustrations one press asks for. Small enough that the first page is quick. */
const GALLERY_PAGE = 12;

/**
 * The card-art control (criteria `G05`, `B06`).
 *
 * Three states, in the order of the decision. Off, and the only thing offered is *read what
 * this would do*. Read, and the switch appears under the prose — not beside it, and not behind
 * a disclosure triangle, because the switch is the only thing here that sends anything and
 * nobody should be able to reach it without the sentence above it having been on screen. On,
 * and it is a gallery of illustrations to scroll through and press.
 *
 * The gallery replaced a field that took a card's *name*, which was a picker you had to know
 * the answer to: several hundred names, none of them guessable, and nothing on screen to
 * choose from. Pictures are what a person is choosing between, so pictures are what is shown.
 * Each one is drawn over `rrfile://` from bytes already on this disk — see `card-art.ts` for
 * why they arrived that way — and each is an *art crop*, never a whole printed card.
 *
 * Every word of the disclosure comes from the main process, including the host — which is why
 * that name appears nowhere in this file. A component with its own copy of it is a component
 * that can go on naming a host after the code has stopped meaning it, and a disclosure that
 * has drifted from what the application does is worse than none.
 */
function CardArt({
  status,
  disclosure,
  gallery,
  busy,
  onRead,
  onSwitch,
  onMore,
  onChoose,
}: {
  readonly status: CardArtStatus;
  readonly disclosure: CardArtDisclosure | null;
  readonly gallery: CardArtGallery | null;
  readonly busy: boolean;
  readonly onRead: () => void;
  readonly onSwitch: (enabled: boolean) => void;
  readonly onMore: (offset: number) => void;
  readonly onChoose: (name: string) => void;
}): JSX.Element {
  if (status.enabled) {
    const shown = gallery?.entries.length ?? 0;
    return (
      <div className="wr-graph__setting" data-testid="graph-card-art" data-card-art="on">
        <span>{gallery === null ? 'Card art' : `${gallery.setName} art`}</span>
        <div
          className="wr-graph__gallery"
          data-testid="card-art-gallery"
          data-control="graph.gallery"
          data-shown={String(shown)}
          data-total={String(gallery?.total ?? 0)}
        >
          {gallery?.entries.map((entry, index) => (
            <GalleryTile
              key={entry.name}
              entry={entry}
              index={index}
              onChoose={() => {
                onChoose(entry.name);
              }}
            />
          ))}
          {shown === 0 && !busy && (
            <span className="wr-graph__gallery-empty" data-testid="card-art-gallery-empty">
              No art could be fetched.
            </span>
          )}
        </div>
        {gallery !== null && shown < gallery.total && (
          <button
            type="button"
            data-testid="card-art-gallery-more"
            disabled={busy}
            onClick={() => {
              onMore(shown);
            }}
          >
            {busy ? 'Fetching…' : `More of the ${String(gallery.total - shown)} left`}
          </button>
        )}
        <button
          type="button"
          data-testid="graph-card-art-off"
          onClick={() => {
            onSwitch(false);
          }}
        >
          Turn off
        </button>
      </div>
    );
  }

  return (
    <div className="wr-graph__setting" data-testid="graph-card-art" data-card-art="off">
      <button
        type="button"
        data-testid="graph-card-art-read"
        onClick={onRead}
      >
        Card art…
      </button>
      {disclosure !== null && (
        <div className="wr-graph__disclosure" data-testid="card-art-disclosure">
          <p data-testid="card-art-disclosure-headline">{disclosure.headline}</p>
          <p data-testid="card-art-disclosure-destination">{disclosure.destination}</p>
          <ul data-testid="card-art-disclosure-sends">
            {disclosure.sends.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <ul data-testid="card-art-disclosure-withholds">
            {disclosure.withholds.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button
            type="button"
            data-testid="graph-card-art-on"
            onClick={() => {
              onSwitch(true);
            }}
          >
            Turn card art on
          </button>
        </div>
      )}
    </div>
  );
}

interface PanelParams {
  readonly panelId: string;
}

export function graphDescriptorFrom(descriptor: PanelDescriptor | null): {
  seedEntityId: string;
  seedEntityType: string;
} | null {
  if (descriptor === null || descriptor.kind !== 'link-graph') return null;
  if (descriptor.seedEntityId === null || descriptor.seedEntityType === null) return null;
  return {
    seedEntityId: descriptor.seedEntityId,
    seedEntityType: descriptor.seedEntityType,
  };
}

export function GraphPanel({ params }: IDockviewPanelProps<PanelParams>): JSX.Element {
  const state = useWorkspaceState();
  const seed = graphDescriptorFrom(state.panels[params.panelId] ?? null);
  if (seed === null) {
    return (
      <EmptyState
        message="Open a document or a note, then open the graph on it."
        testId="graph-panel-empty"
      />
    );
  }
  return <GraphPanelBody {...seed} />;
}

/**
 * One illustration in the gallery.
 *
 * The picture is addressed by file id and nothing else — the same rule a node's icon follows,
 * and the reason a graph's markup never contains a path or a host. `data-loaded` is set from
 * the element's own load event so a test can tell "the bytes arrived over `rrfile://`" from
 * "an `<img>` element exists", which is the difference between the criterion and its shape.
 *
 * A crop with no file behind it is drawn as its name: a gallery with a gap in it is honest,
 * and dropping the entry would silently renumber everything after it.
 */
function GalleryTile({
  entry,
  index,
  onChoose,
}: {
  readonly entry: CardArtGalleryEntry;
  readonly index: number;
  readonly onChoose: () => void;
}): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      type="button"
      className="wr-graph__gallery-tile"
      data-testid={`card-art-tile-${String(index)}`}
      data-card-name={entry.name}
      data-file-id={entry.iconFileId ?? ''}
      data-loaded={loaded ? 'true' : 'false'}
      title={entry.artist === '' ? entry.name : `${entry.name} — ${entry.artist}`}
      onClick={onChoose}
    >
      {entry.iconFileId === null ? (
        <span className="wr-graph__gallery-missing">{entry.name}</span>
      ) : (
        <img
          src={`rrfile://${entry.iconFileId}`}
          alt={entry.name}
          onLoad={() => {
            setLoaded(true);
          }}
        />
      )}
    </button>
  );
}
