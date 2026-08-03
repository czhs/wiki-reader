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
  /**
   * Add a block after the one last written in, else at the end (`S08`).
   *
   * What a **keyboard** shortcut means, and it is not `insertAfter(null, …)`: a chord carries
   * no block with it, so the surface has to remember where the researcher was. A right-click
   * still names its block and still goes through `insertAfter`.
   */
  readonly insertHere: (src: string) => void;
  /**
   * Ask this surface for a picture, or for a highlight (`S08`).
   *
   * Optional because they are the *notebook page's* — a journal day quotes nothing and its
   * pictures arrive by being dropped. A command aimed at a surface that has neither says so
   * rather than doing nothing.
   */
  readonly pickImage?: (() => void) | undefined;
  readonly pickExcerpt?: (() => void) | undefined;
  /** Write the document now, without closing the block being typed in (`P12`). */
  readonly save: () => void;
  /** Take a block out of the document and write it (`P07`). */
  readonly remove: (index: number) => void;
}

/**
 * The mounted surfaces, **least recently reached for first**.
 *
 * A `Map` iterates in insertion order and `set` on a key it already has does not move it, so
 * `#reach` deletes before it sets. The order is what makes `inHand` recoverable: when the
 * surface in hand goes away, the hand falls back to the last of these rather than to nothing.
 */
const SURFACES = new Map<string, BlockSurface>();
let inHand: string | null = null;

/** Move a surface to the end of the order and put it in hand. */
function reach(surfaceId: string): void {
  const surface = SURFACES.get(surfaceId);
  if (surface === undefined) return;
  SURFACES.delete(surfaceId);
  SURFACES.set(surfaceId, surface);
  inHand = surfaceId;
}

/** The most recently reached surface still mounted, or null when none is. */
function mostRecent(): string | null {
  let last: string | null = null;
  for (const id of SURFACES.keys()) last = id;
  return last;
}

/** Register a mounted surface. Returns the disposer its effect must call. */
export function registerBlockSurface(surfaceId: string, surface: BlockSurface): () => void {
  SURFACES.set(surfaceId, surface);
  reach(surfaceId);
  return () => {
    if (SURFACES.get(surfaceId) === surface) SURFACES.delete(surfaceId);
    // The hand goes back to whatever is still mounted, never to nothing while a writing
    // surface is on screen. `P09` puts a second one over the first — the journal pop-up —
    // and closing it used to leave `inHand` null: `Cmd+S` then answered "open a notebook page
    // first" over an open notebook page, and every keystroke since the last commit was lost.
    // Re-registration cannot rescue it, because the page's handle and surfaceId are stable.
    if (inHand === surfaceId) inHand = mostRecent();
  };
}

/** Remember which surface the researcher last wrote in — the one a bare command means. */
export function touchBlockSurface(surfaceId: string): void {
  reach(surfaceId);
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
