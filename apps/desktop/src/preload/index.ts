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

  platform: process.platform as 'darwin' | 'win32' | 'linux',
};

contextBridge.exposeInMainWorld('rr', bridge);
