/**
 * Preload bridge.
 *
 * Exposes exactly two functions: a typed `invoke` and a typed `subscribe`. No raw
 * ipcRenderer, no filesystem, no database, no shell. Every channel name is checked against
 * the contract before it reaches the main process, and the main process validates the
 * payload again on arrival.
 *
 * It also *handles* one thing rather than exposing it: a file dropped on a desk board. That
 * is here because a dropped `File` can only be turned into a path by `webUtils.getPathForFile`,
 * which exists in the preload and nowhere the renderer can reach. The preload shares the DOM
 * with the page but not its JavaScript world, so it can read the drop, resolve the path, and
 * hand it to the main process without the path ever existing in a world the page can read.
 *
 * The path goes over `wr:drop`, deliberately *not* over `wr:invoke`. The renderer can invoke
 * any channel in the contract, so a channel that accepted a filesystem path would let a
 * compromised renderer name `~/.ssh/id_rsa`, have it added to the library, and read it back
 * over `rrfile://`. `wr:drop` is not exposed on the bridge, so the page cannot address it at
 * all — and the bridge still offers exactly two functions and nothing else.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const INVOKE_CHANNEL = 'wr:invoke';
const EVENT_CHANNEL = 'wr:event';
const DROP_CHANNEL = 'wr:drop';

/** The attribute a desk board carries, holding the question whose board it is. */
const DROP_TARGET_ATTRIBUTE = 'data-wr-drop-question';

/**
 * The attribute the library carries. A drop here adds the file to the library and puts it on
 * no board — the same act, with nothing to relate it to yet (criterion B02).
 */
const LIBRARY_TARGET_ATTRIBUTE = 'data-wr-drop-library';

const bridge = {
  invoke(channel: string, request: unknown): Promise<unknown> {
    return ipcRenderer.invoke(INVOKE_CHANNEL, { channel, request });
  },

  subscribe(topic: string, handler: (payload: unknown) => void): () => void {
    const listener = (_event: unknown, message: { topic: string; payload: unknown }): void => {
      if (message.topic === topic) handler(message.payload);
    };
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, listener);
    };
  },
};

// Exactly two functions, and nothing else. The renderer needs the platform for its
// keybindings, but it derives that from `navigator` rather than being handed a slice of
// `process` — a bridge that exposes two functions is trivially auditable, and one that
// exposes "two functions plus a few harmless properties" is the shape that grows.

contextBridge.exposeInMainWorld('rr', bridge);

/**
 * What is under a drop: a question's board, the library, or nothing that accepts files.
 *
 * `closest` over both attributes at once, so the innermost target wins — a board rendered
 * inside a panel that also accepts files must not have its drops taken by the outer one.
 */
function targetUnder(target: EventTarget | null): { readonly questionId: string | null } | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest(`[${DROP_TARGET_ATTRIBUTE}], [${LIBRARY_TARGET_ATTRIBUTE}]`);
  if (element === null) return null;
  const questionId = element.getAttribute(DROP_TARGET_ATTRIBUTE);
  if (questionId !== null) return { questionId };
  return { questionId: null };
}

/**
 * Whether this drag is carrying files from outside the app.
 *
 * Everything below is scoped to those. The workspace drags tabs between groups with the same
 * HTML5 mechanism, and a listener that cancelled every `dragover` — or set `dropEffect` on one
 * — would quietly decide what happens to a drag that is none of its business.
 */
const carriesFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

// Dropping a file on a window is, by default, a navigation: Chromium replaces the page with
// the file. Navigation away from the app origin is refused in the main process, so the page
// survives either way, but the default is cancelled here as well — a refusal in the log is
// not the same as a drop that was never an attempt.
window.addEventListener(
  'dragover',
  (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = targetUnder(event.target) === null ? 'none' : 'copy';
    }
  },
  true,
);

window.addEventListener(
  'drop',
  (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const landed = targetUnder(event.target);
    const files = event.dataTransfer?.files;
    if (landed === null || files === undefined) return;

    const paths: string[] = [];
    for (const file of Array.from(files)) {
      // The one call that turns a `File` into a path. Its answer never reaches the page: it
      // goes straight out on a channel the page cannot address.
      const path = webUtils.getPathForFile(file);
      if (path !== '') paths.push(path);
    }
    if (paths.length === 0) return;

    // Fire and forget: the renderer learns what came of it from the `notebook:changed` and
    // `library:changed` events the main process publishes, which is also how a second window
    // would hear about it.
    void ipcRenderer.invoke(DROP_CHANNEL, { questionId: landed.questionId, paths });
  },
  true,
);
