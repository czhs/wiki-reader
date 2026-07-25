/**
 * Zotero 7 local HTTP API client.
 *
 * Read-only, by construction: only GET is ever issued. `~/Zotero/zotero.sqlite` is never
 * opened — Zotero holds a lock on it and writing there would corrupt a live library.
 *
 * The local API is served by the running Zotero process at 127.0.0.1:23119 and is only
 * enabled once the user ticks "Allow other applications on this computer to communicate
 * with Zotero" (Settings -> Advanced). Until then it answers 403, which is a *user action*
 * to fix, not a bug — so it is reported as its own error code with a remedy string.
 */
import type { z } from 'zod';
import type { IpcErrorCode } from '@wr/shared-types';
import {
  ZoteroCollectionListSchema,
  ZoteroItemListSchema,
  ZoteroItemSchema,
  ZoteroTagListSchema,
  type ZoteroCollection,
  type ZoteroItem,
  type ZoteroTag,
} from './wire.js';

export const DEFAULT_ZOTERO_ENDPOINT = 'http://127.0.0.1:23119';

/** Zotero's local API always addresses the local library as user 0. */
export const LOCAL_USER_ID = 0;

export class ZoteroError extends Error {
  constructor(
    readonly code: Extract<
      IpcErrorCode,
      'ZOTERO_UNREACHABLE' | 'ZOTERO_API_DISABLED' | 'ZOTERO_HTTP_ERROR'
    >,
    message: string,
    readonly remedy: string | null = null,
    readonly status: number | null = null,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'ZoteroError';
  }
}

export const API_DISABLED_REMEDY =
  'In Zotero, open Settings -> Advanced and enable ' +
  '"Allow other applications on this computer to communicate with Zotero".';

const NOT_RUNNING_REMEDY = 'Start Zotero 7 and leave it running, then retry the import.';

export interface ZoteroProbe {
  readonly running: boolean;
  readonly localApiEnabled: boolean;
  readonly libraryVersion: number | null;
  readonly endpoint: string;
  readonly message: string;
  readonly remedy: string | null;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface ZoteroClientOptions {
  readonly endpoint?: string;
  readonly userId?: number;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Page size for list endpoints. Zotero caps this at 100. */
  readonly pageSize?: number;
}

export class ZoteroLocalClient {
  private readonly endpoint: string;
  private readonly userId: number;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(options: ZoteroClientOptions = {}) {
    this.endpoint = (options.endpoint ?? DEFAULT_ZOTERO_ENDPOINT).replace(/\/$/, '');
    this.userId = options.userId ?? LOCAL_USER_ID;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.pageSize = Math.min(options.pageSize ?? 100, 100);
  }

  get apiBase(): string {
    return `${this.endpoint}/api/users/${this.userId}`;
  }

  /**
   * Distinguish "Zotero is not running" from "the local API is switched off".
   *
   * These need different remedies, and conflating them sends the user hunting for the
   * wrong problem, so probe never throws — it reports.
   */
  async probe(): Promise<ZoteroProbe> {
    let running: boolean;
    try {
      await this.request(`${this.endpoint}/connector/ping`);
      running = true;
    } catch (error) {
      if (error instanceof ZoteroError && error.code === 'ZOTERO_UNREACHABLE') {
        return {
          running: false,
          localApiEnabled: false,
          libraryVersion: null,
          endpoint: this.apiBase,
          message: 'Zotero is not running.',
          remedy: NOT_RUNNING_REMEDY,
        };
      }
      // A ping that answers with an HTTP error still proves the process is listening.
      running = true;
    }

    try {
      const response = await this.request(`${this.apiBase}/items/top?limit=1`);
      const header = response.headers.get('Last-Modified-Version');
      const libraryVersion = header === null ? null : Number.parseInt(header, 10);
      return {
        running,
        localApiEnabled: true,
        libraryVersion: Number.isNaN(libraryVersion ?? Number.NaN) ? null : libraryVersion,
        endpoint: this.apiBase,
        message: 'Zotero local API is reachable.',
        remedy: null,
      };
    } catch (error) {
      if (error instanceof ZoteroError) {
        return {
          running,
          localApiEnabled: false,
          libraryVersion: null,
          endpoint: this.apiBase,
          message: error.message,
          remedy: error.remedy,
        };
      }
      throw error;
    }
  }

  async listCollections(): Promise<ZoteroCollection[]> {
    return this.paginate('/collections', ZoteroCollectionListSchema);
  }

  async listTags(): Promise<ZoteroTag[]> {
    return this.paginate('/tags', ZoteroTagListSchema);
  }

  /** Top-level items only: attachments and notes arrive through `listChildren`. */
  async listTopItems(): Promise<ZoteroItem[]> {
    return this.paginate('/items/top', ZoteroItemListSchema);
  }

  async listChildren(itemKey: string): Promise<ZoteroItem[]> {
    return this.paginate(`/items/${encodeURIComponent(itemKey)}/children`, ZoteroItemListSchema);
  }

  async getItem(itemKey: string): Promise<ZoteroItem> {
    const response = await this.request(`${this.apiBase}/items/${encodeURIComponent(itemKey)}`);
    return ZoteroItemSchema.parse(await response.json());
  }

  /**
   * Walk `start`/`limit` until a short page arrives.
   *
   * `Total-Results` is used only as a loop guard: trusting it as the terminating condition
   * breaks when the library changes mid-walk.
   */
  private async paginate<T>(path: string, schema: z.ZodType<T[]>): Promise<T[]> {
    const collected: T[] = [];
    let start = 0;

    for (;;) {
      const url = `${this.apiBase}${path}${path.includes('?') ? '&' : '?'}limit=${this.pageSize}&start=${start}`;
      const response = await this.request(url);
      const page = schema.parse(await response.json());
      collected.push(...page);

      if (page.length < this.pageSize) return collected;
      start += page.length;

      const total = Number.parseInt(response.headers.get('Total-Results') ?? '', 10);
      if (!Number.isNaN(total) && collected.length >= total) return collected;
    }
  }

  private async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(url, { signal: controller.signal });
    } catch (cause) {
      throw new ZoteroError(
        'ZOTERO_UNREACHABLE',
        `Could not reach the Zotero local API at ${this.endpoint}.`,
        NOT_RUNNING_REMEDY,
        null,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 403) {
      throw new ZoteroError(
        'ZOTERO_API_DISABLED',
        'Zotero refused the request: the local API is disabled.',
        API_DISABLED_REMEDY,
        403,
      );
    }
    if (!response.ok) {
      throw new ZoteroError(
        'ZOTERO_HTTP_ERROR',
        `Zotero local API returned HTTP ${String(response.status)} for ${url}.`,
        null,
        response.status,
      );
    }
    return response;
  }
}
