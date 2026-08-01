/**
 * Which writing surfaces are mounted, and which one is in hand (criterion `R01`).
 *
 * A module of its own, with no React in it, for two reasons. The workbench host looks a
 * surface up from inside a command handler — not a render — so there is no component in scope
 * to ask and no hook that could answer; and `host.ts` importing the block editor directly
 * would close a cycle, because the editor reaches the workbench through `workspace.tsx`, which
 * is what constructs the host.
 *
 * A surface is named by its owner (`notebook:<id>`, `journal:<id>`) rather than by its testid
 * prefix: two notebook pages can be open side by side, and a command aimed at "the notebook"
 * would otherwise land in whichever of them mounted last.
 */

/** What a command can ask a mounted writing surface to do. */
export interface BlockSurface {
  /** Open a block for editing, caret at `offset` (defaults to its end). */
  readonly open: (index: number, offset?: number) => void;
  /** Add a block after `index` and open it; `null` appends. */
  readonly insertAfter: (index: number | null, src: string) => void;
  /** Write the document now, without closing the block being typed in (`P12`). */
  readonly save: () => void;
  /** Take a block out of the document and write it (`P07`). */
  readonly remove: (index: number) => void;
}

const SURFACES = new Map<string, BlockSurface>();
let inHand: string | null = null;

/** Register a mounted surface. Returns the disposer its effect must call. */
export function registerBlockSurface(surfaceId: string, surface: BlockSurface): () => void {
  SURFACES.set(surfaceId, surface);
  inHand = surfaceId;
  return () => {
    if (SURFACES.get(surfaceId) === surface) SURFACES.delete(surfaceId);
    if (inHand === surfaceId) inHand = null;
  };
}

/** Remember which surface the researcher last wrote in — the one a bare command means. */
export function touchBlockSurface(surfaceId: string): void {
  if (SURFACES.has(surfaceId)) inHand = surfaceId;
}

/**
 * The surface a command should act on: the one it named, else the one in hand.
 *
 * `null` when nothing is mounted, which the caller reports rather than silently doing nothing —
 * the same rule every command with a missing subject follows.
 */
export function blockSurface(surfaceId: string | null): BlockSurface | null {
  const id = surfaceId ?? inHand;
  if (id === null) return null;
  return SURFACES.get(id) ?? null;
}
