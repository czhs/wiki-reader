import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '../src/client.js';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as unknown;

export interface FakeApiOptions {
  /** Force a status for every API request, to exercise the error paths. */
  readonly status?: number;
  /** Reject at the socket level, as a stopped Zotero would. */
  readonly offline?: boolean;
  /** Override the item list, e.g. to simulate an upstream edit between imports. */
  readonly items?: unknown[];
}

/**
 * A fetch that serves the recorded fixtures over the real Zotero URL shapes.
 *
 * Driving `ZoteroLocalClient` through this exercises the actual client — pagination,
 * header handling, schema parsing and error mapping — instead of stubbing it out, so the
 * import tests cover the same code path that runs against a live Zotero.
 */
export function fixtureFetch(options: FakeApiOptions = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const topItems = options.items ?? (load('items-top.json') as unknown[]);
  const children = load('items-children.json') as { data: { parentItem?: string } }[];
  const collections = load('collections.json') as unknown[];
  const tags = load('tags.json') as unknown[];

  const respond = (body: unknown, total: number): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Total-Results': String(total),
        'Last-Modified-Version': '632',
      },
    });

  const fn: FetchLike = (rawUrl) => {
    calls.push(rawUrl);
    if (options.offline === true) return Promise.reject(new TypeError('fetch failed'));
    if (options.status !== undefined && !rawUrl.includes('/connector/ping')) {
      return Promise.resolve(new Response('', { status: options.status }));
    }

    const url = new URL(rawUrl);
    const { pathname } = url;
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    const start = Number.parseInt(url.searchParams.get('start') ?? '0', 10);
    const page = <T,>(all: T[]): Response => respond(all.slice(start, start + limit), all.length);

    if (pathname.endsWith('/connector/ping')) return Promise.resolve(new Response('ok'));
    if (pathname.endsWith('/items/top')) return Promise.resolve(page(topItems));
    if (pathname.endsWith('/collections')) return Promise.resolve(page(collections));
    if (pathname.endsWith('/tags')) return Promise.resolve(page(tags));

    const childMatch = /\/items\/([A-Z0-9]+)\/children$/.exec(pathname);
    if (childMatch !== null) {
      const parent = childMatch[1];
      return Promise.resolve(page(children.filter((c) => c.data.parentItem === parent)));
    }

    return Promise.resolve(new Response('not found', { status: 404 }));
  };

  return Object.assign(fn, { calls });
}
