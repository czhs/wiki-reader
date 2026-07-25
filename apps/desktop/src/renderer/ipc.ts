/**
 * The renderer's only door to the main process.
 *
 * `window.rr` is the two-function preload bridge. Everything here is a thin, typed shell
 * around it: it turns the `IpcResult` envelope into a value or a throw, so panels can be
 * written with ordinary `try`/`catch` instead of threading a result type through every
 * component, and it keeps the `window.rr` cast in exactly one place.
 */
import type {
  IpcChannel,
  IpcError,
  IpcRequest,
  IpcResponse,
  IpcTopic,
  IpcTopicPayload,
  RendererBridge,
} from '@wr/shared-types';

declare global {
  interface Window {
    readonly rr: RendererBridge;
  }
}

/** An error the main process reported. Carries the code and remedy for the UI to show. */
export class IpcCallError extends Error {
  readonly code: IpcError['code'];
  readonly remedy: string | null;

  constructor(channel: string, error: IpcError) {
    super(`${channel}: ${error.message}`);
    this.name = 'IpcCallError';
    this.code = error.code;
    this.remedy = error.remedy ?? null;
  }
}

function bridge(): RendererBridge {
  const value = window.rr;
  if (value === undefined) {
    // Only reachable if the preload failed to load, which would otherwise surface as a
    // confusing "cannot read property invoke of undefined" deep inside a panel.
    throw new Error('renderer: the preload bridge is missing (window.rr is undefined)');
  }
  return value;
}

/** Call a channel and unwrap the result. Throws `IpcCallError` when the main process failed. */
export async function call<K extends IpcChannel>(
  channel: K,
  request: IpcRequest<K>,
): Promise<IpcResponse<K>> {
  const result = await bridge().invoke(channel, request);
  if (!result.ok) throw new IpcCallError(channel, result.error);
  return result.value;
}

export function subscribe<K extends IpcTopic>(
  topic: K,
  handler: (payload: IpcTopicPayload<K>) => void,
): () => void {
  return bridge().subscribe(topic, handler);
}

/** The message to show the user for any thrown value. */
export function describeError(error: unknown): { message: string; remedy: string | null } {
  if (error instanceof IpcCallError) return { message: error.message, remedy: error.remedy };
  if (error instanceof Error) return { message: error.message, remedy: null };
  return { message: String(error), remedy: null };
}
