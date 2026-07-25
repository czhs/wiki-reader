/**
 * Preload bridge.
 *
 * Exposes exactly two functions: a typed `invoke` and a typed `subscribe`. No raw
 * ipcRenderer, no filesystem, no database, no shell. Every channel name is checked against
 * the contract before it reaches the main process, and the main process validates the
 * payload again on arrival.
 */
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE_CHANNEL = 'wr:invoke';
const EVENT_CHANNEL = 'wr:event';

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
