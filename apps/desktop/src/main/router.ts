/**
 * The one and only IPC entry point.
 *
 * `scripts/verify_completion.py` asserts that no `ipcMain.handle` call exists outside this
 * module. Everything the renderer can ask for arrives on a single channel, is matched
 * against the channel table, is validated with that channel's zod schema *before* any
 * handler runs, and comes back as a discriminated `IpcResult` — so a rejected promise can
 * never leak a stack trace or a filesystem path into the renderer.
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z, ZodError } from 'zod';
import {
  IPC_CHANNELS,
  IPC_TOPICS,
  ipcErr,
  ipcOk,
  isIpcChannel,
  QuestionIdSchema,
  type IpcChannel,
  type IpcError,
  type IpcResult,
  type IpcTopic,
  type IpcTopicPayload,
} from '@wr/shared-types';
import { ZoteroError } from '@wr/zotero-adapter';
import { createHandlers, HandlerError, receiveDrop, type Handlers } from './handlers.js';
import type { AppServices } from './services.js';
import type { Logger } from './logger.js';

export const INVOKE_CHANNEL = 'wr:invoke';
export const EVENT_CHANNEL = 'wr:event';

/**
 * Files dropped on a desk board (criterion N07).
 *
 * A second channel, and the only one that is *not* reachable from the renderer: the preload
 * exposes `invoke` and `subscribe` and neither can address this name. That asymmetry is the
 * point. The payload is a list of filesystem paths, and a path the renderer could choose
 * would be an arbitrary-file-read — it would be added to the library and then served back
 * over `rrfile://`. Here the paths come from `webUtils.getPathForFile` in the preload, which
 * can only answer for a file the operating system just handed over.
 *
 * It still lives in this module, because "every `ipcMain.handle` is in the router" is what
 * makes the IPC surface auditable by reading one file, and it is validated with zod before
 * the handler runs like everything else.
 */
export const DROP_CHANNEL = 'wr:drop';

const DropRequestSchema = z.object({
  /**
   * The board the files landed on, or null for a drop on the library itself (criterion B02).
   * Null is a target, not a missing one: a paper added to the library is not yet related to
   * anything, and inventing a question to hang it off would be inventing a judgement.
   */
  questionId: QuestionIdSchema.nullable().default(null),
  /** Absolute paths, as the OS reported them. Bounded: a drop is a handful of files. */
  paths: z.array(z.string().min(1).max(4096)).min(1).max(50),
});

const IS_PRODUCTION = process.env['NODE_ENV'] === 'production';

/** The envelope the preload sends. Validated structurally before the channel is trusted. */
interface InvokeEnvelope {
  readonly channel: string;
  readonly request: unknown;
}

function isEnvelope(value: unknown): value is InvokeEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'channel') === 'string' &&
    'request' in value
  );
}

/**
 * Map a thrown value onto the error envelope.
 *
 * Unknown failures collapse to INTERNAL with a generic message: the real message may name a
 * path or a SQL fragment, and the renderer is not entitled to either. The detail goes to the
 * log instead.
 */
export function toIpcError(error: unknown): IpcError {
  if (error instanceof HandlerError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.remedy === undefined ? {} : { remedy: error.remedy }),
    };
  }

  if (error instanceof ZoteroError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.remedy === undefined || error.remedy === null ? {} : { remedy: error.remedy }),
    };
  }

  if (error instanceof ZodError) {
    return {
      code: 'INVALID_REQUEST',
      message: 'The request did not match the channel contract.',
      details: { issues: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    };
  }

  // SQLITE_CONSTRAINT and friends carry a `code` worth distinguishing from a generic bug.
  if (error instanceof Error && error.message.includes('SQLITE_')) {
    return { code: 'DATABASE_ERROR', message: 'The database rejected the operation.' };
  }

  return { code: 'INTERNAL', message: 'The operation failed.' };
}

/**
 * Validate and dispatch one request. Exported so tests can drive the full router path —
 * including schema validation and error mapping — without an Electron process.
 */
export async function dispatch(
  handlers: Handlers,
  channel: string,
  request: unknown,
  logger: Logger,
): Promise<IpcResult<unknown>> {
  if (!isIpcChannel(channel)) {
    logger.warn('unknown ipc channel rejected', { channel });
    return ipcErr({ code: 'INVALID_REQUEST', message: `Unknown channel: ${channel}` });
  }

  const contract = IPC_CHANNELS[channel];
  const parsed = contract.request.safeParse(request ?? {});
  if (!parsed.success) {
    logger.warn('ipc request failed validation', {
      channel,
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
    return ipcErr(toIpcError(parsed.error));
  }

  try {
    // The channel key and its parsed payload are correlated by construction, but that
    // correlation is not expressible across the whole union without a per-channel switch.
    const handler = handlers[channel] as (input: unknown) => Promise<unknown> | unknown;
    const value = await handler(parsed.data);

    // Outside production the response is checked against the same contract the renderer
    // relies on. A handler that drifts from its schema otherwise shows up as an undefined
    // field somewhere in the UI, arbitrarily far from the handler that caused it. This is
    // skipped in production because re-parsing a large search payload is not free.
    if (!IS_PRODUCTION) {
      const checked = contract.response.safeParse(value);
      if (!checked.success) {
        logger.error('handler response failed its own contract', {
          channel,
          issues: checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
        return ipcErr({ code: 'INTERNAL', message: 'The operation failed.' });
      }
      return ipcOk(checked.data);
    }

    return ipcOk(value);
  } catch (error) {
    const mapped = toIpcError(error);
    logger.error('ipc handler failed', { channel, code: mapped.code, error });
    return ipcErr(mapped);
  }
}

export interface Router {
  readonly dispose: () => void;
  readonly publish: <K extends IpcTopic>(topic: K, payload: IpcTopicPayload<K>) => void;
}

/**
 * Register the router.
 *
 * `targets` returns the live renderer list at publish time rather than capturing it, so a
 * window opened after startup still receives events and a destroyed one is skipped.
 */
export function registerRouter(
  services: AppServices,
  targets: () => readonly WebContents[],
): Router {
  const handlers = createHandlers(services);
  const logger = services.logger.child('ipc');

  ipcMain.handle(INVOKE_CHANNEL, async (_event: IpcMainInvokeEvent, payload: unknown) => {
    if (!isEnvelope(payload)) {
      logger.warn('malformed ipc envelope rejected');
      return ipcErr({ code: 'INVALID_REQUEST', message: 'Malformed request envelope.' });
    }
    return dispatch(handlers, payload.channel, payload.request, logger);
  });

  ipcMain.handle(DROP_CHANNEL, async (_event: IpcMainInvokeEvent, payload: unknown) => {
    const parsed = DropRequestSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn('malformed drop rejected');
      return ipcErr({ code: 'INVALID_REQUEST', message: 'Malformed drop.' });
    }
    try {
      return ipcOk(await receiveDrop(services, parsed.data));
    } catch (error) {
      const mapped = toIpcError(error);
      logger.error('drop failed', { code: mapped.code, error });
      return ipcErr(mapped);
    }
  });

  return {
    dispose: () => {
      ipcMain.removeHandler(INVOKE_CHANNEL);
      ipcMain.removeHandler(DROP_CHANNEL);
    },
    publish: (topic, payload) => {
      // Validated on the way out too: a malformed event would otherwise surface as an
      // unexplained renderer crash far from the code that produced it.
      const schema = IPC_TOPICS[topic];
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        logger.error('refusing to publish malformed event', { topic });
        return;
      }
      for (const contents of targets()) {
        if (!contents.isDestroyed()) contents.send(EVENT_CHANNEL, { topic, payload: parsed.data });
      }
    },
  };
}

export type { Handlers };
export const CHANNEL_NAMES: readonly IpcChannel[] = Object.keys(IPC_CHANNELS) as IpcChannel[];
