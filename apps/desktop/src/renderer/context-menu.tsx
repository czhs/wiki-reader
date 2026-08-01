/**
 * The right hand: a menu of what makes sense on the thing under the pointer (criterion `R01`).
 *
 * Two pieces, and the smaller one is the point. `useOpenContextMenu` is what a surface calls
 * from its `onContextMenu`; it says *what was clicked* — a library row, a tab, a disc on the
 * map, a marked sentence, a notebook, a block — and hands over the arguments that describe that
 * thing. It never says what the menu should offer. `ContextMenu` answers that by asking the
 * workbench, which reads its command registry and its keybinding registry through
 * `menus.ts`: the wording, the ordering by category, the key printed beside an item and
 * whether the item appears at all all come from the same two registries the help page (`D02`)
 * and the guide are built from. There is no second list of actions anywhere in this file.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not reach inside the archive frame.** A right-click on a saved page happens in a
 *   sandboxed nested browsing context whose events never cross into this document, and that
 *   gesture is already spoken for: Chromium reports the frame's selection to the main process,
 *   which is the only way a highlight can be made on an archived page (`H01`). So the frame
 *   keeps its gesture and the reader's chrome around it gets the menu — composed, not collided.
 * - **It offers nothing the surface guards.** Discarding and deleting a notebook are the
 *   queue's, in that order and with their confirmations; the menu on a notebook opens it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { DocumentId, LinkableEntityType } from '@wr/shared-types';
import type { ContextMenuKind, EntityRef } from '@wr/workbench';
import { useCloseOnEscape, Chord } from './overlays.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** How far the menu keeps from the window's edges when the pointer is near one. */
const EDGE_MARGIN = 8;

/**
 * The arguments an entity-shaped target hands to the menu.
 *
 * Both spellings, because the commands read two: navigation commands take `entityId`/
 * `entityType` and the two gestures that make something — a link, a card on a desk — take
 * `sourceId`/`sourceType`, deliberately, so that hovering a citation cannot change which end a
 * link is made from. A menu knows exactly what was right-clicked, so it can answer both
 * without either being a guess.
 */
export function entityMenuArgs(entity: EntityRef): Record<string, unknown> {
  return {
    entityId: entity.entityId,
    entityType: entity.entityType,
    ...(entity.documentId === undefined ? {} : { documentId: entity.documentId }),
    sourceId: entity.entityId,
    sourceType: entity.entityType,
  };
}

/**
 * Open the menu for a target.
 *
 * Takes the event so the caller cannot forget `preventDefault` — an unhandled right-click in
 * Electron does nothing at all, and a menu that appeared *beside* a native one would be the
 * second list of actions this criterion exists to prevent.
 */
export function useOpenContextMenu(): (
  event: ReactMouseEvent,
  kind: ContextMenuKind,
  args?: Readonly<Record<string, unknown>>,
) => void {
  const { store } = useWorkspace();
  return useCallback(
    (event, kind, args = {}) => {
      event.preventDefault();
      event.stopPropagation();
      store.update({ contextMenu: { kind, args, x: event.clientX, y: event.clientY } });
    },
    [store],
  );
}

/**
 * The menu for a disc on any of the three graph surfaces.
 *
 * One hook, because the wiki, the neighbourhood panel and the focused view draw the same
 * `SceneNode` and a node means the same thing on all three — which is the point of the map:
 * what a file can be asked there is what it can be asked in the library.
 */
export function useGraphNodeMenu(): (
  event: ReactMouseEvent,
  node: {
    readonly entityType: LinkableEntityType;
    readonly entityId: string;
    /** The file the node stands for or lives in; `null` for one with no file of its own. */
    readonly documentId?: DocumentId | null;
  },
) => void {
  const openMenu = useOpenContextMenu();
  return useCallback(
    (event, node) => {
      openMenu(
        event,
        'graph-node',
        entityMenuArgs({
          entityId: node.entityId,
          entityType: node.entityType,
          ...(node.documentId === null || node.documentId === undefined
            ? {}
            : { documentId: node.documentId }),
        }),
      );
    },
    [openMenu],
  );
}

export function ContextMenu(): JSX.Element | null {
  const { store, workbench, run } = useWorkspace();
  const state = useWorkspaceState();
  const request = state.contextMenu;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  const close = useCallback(() => {
    store.update({ contextMenu: null });
  }, [store]);

  useCloseOnEscape(request !== null, close);

  // The registries, read now rather than when the click happened: a menu is a live view of
  // what the app can do here, exactly like the command list.
  const groups = useMemo(
    () => (request === null ? [] : workbench.contextMenu(request.kind, request.args)),
    [request, workbench],
  );

  // Placed after the first paint, when the menu's real size is known: a menu opened near the
  // right edge of a 1440px window is the ordinary case on a two-panel layout, and one drawn
  // off-screen is one nobody can use.
  useLayoutEffect(() => {
    if (request === null) {
      setPlacement(null);
      return;
    }
    const element = menuRef.current;
    if (element === null) return;
    const { width, height } = element.getBoundingClientRect();
    const left = Math.max(
      EDGE_MARGIN,
      Math.min(request.x, window.innerWidth - width - EDGE_MARGIN),
    );
    const top = Math.max(
      EDGE_MARGIN,
      Math.min(request.y, window.innerHeight - height - EDGE_MARGIN),
    );
    setPlacement({ left, top });
  }, [request]);

  // The keyboard reaches it the moment it opens, so Escape and Tab behave and a screen reader
  // is told a menu appeared.
  useEffect(() => {
    if (request === null) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [request, groups]);

  if (request === null) return null;
  // Nothing to offer is not an empty menu: it is no menu. An empty box under the pointer says
  // the feature is broken; nothing says this thing has no actions, which is the truth.
  if (groups.length === 0) return null;

  return (
    <div className="wr-menu-layer" data-testid="context-menu-layer">
      <div
        className="wr-menu__scrim"
        data-testid="context-menu-scrim"
        role="presentation"
        onClick={close}
        onContextMenu={(event) => {
          event.preventDefault();
          close();
        }}
      />
      <div
        className="wr-menu"
        ref={menuRef}
        role="menu"
        aria-label="Actions for what you right-clicked"
        data-testid="context-menu"
        data-menu-kind={request.kind}
        data-item-count={String(groups.reduce((total, group) => total + group.items.length, 0))}
        style={{
          left: `${String(placement?.left ?? request.x)}px`,
          top: `${String(placement?.top ?? request.y)}px`,
          // Hidden rather than unmounted until it has been measured: the measurement needs the
          // real element, and a menu that visibly jumps from the pointer to its final place is
          // a flicker on every single right-click.
          visibility: placement === null ? 'hidden' : 'visible',
        }}
      >
        {groups.map((group, index) => (
          <div className="wr-menu__group" key={group.items[0]?.commandId ?? String(index)}>
            {group.items.map((item) => (
              <button
                key={item.commandId}
                type="button"
                role="menuitem"
                className="wr-menu__item"
                data-testid={`context-menu-item-${item.commandId}`}
                data-command-id={item.commandId}
                title={item.label}
                onClick={() => {
                  close();
                  void run(item.commandId, item.args);
                }}
              >
                <span className="wr-menu__title">{item.title}</span>
                <Chord chord={item.chords[0]} platform={workbench.keybindings.platform} />
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
