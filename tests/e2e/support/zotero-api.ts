/**
 * The recorded Zotero local API, served over a real socket (criteria B01, B05).
 *
 * Importing a collection from the interface is a claim about the whole path — a button in the
 * renderer, the router, the importer, the client, a socket — and the seeding in
 * `workspace.ts` covers none of it: it drives `ZoteroImporter` in this process, over an
 * injected fetch, before Electron starts. Once the app is running there is no injection point
 * left, so an end-to-end import needs something listening.
 *
 * Zotero is not running on the machine that runs this suite, and starting one is not the
 * suite's to do. So the fixtures get a socket of their own: an ephemeral **loopback** port,
 * handed to the app in `WR_ZOTERO_ENDPOINT`, which production accepts because Zotero's own
 * port is a preference and an installation that moved it has to be able to say so. The
 * variable is loopback-only (`resolveZoteroEndpoint`), so it cannot point the importer off the
 * machine.
 *
 * Not port 23119. A Zotero somebody starts mid-run would collide with it, and the test would
 * be reading their real library.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureFetch } from '../../../packages/zotero-adapter/test/fake-api.js';

export interface FixtureZoteroApi {
  /** `http://127.0.0.1:<port>` — what `WR_ZOTERO_ENDPOINT` is set to. */
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

/**
 * Start the fixture API and return where it is listening.
 *
 * The handler delegates to `fixtureFetch`, the same recorded responses the unit and
 * integration suites use, so what the app imports here is what they import: one recording,
 * one set of facts about the library.
 */
export async function startZoteroApi(children: readonly unknown[]): Promise<FixtureZoteroApi> {
  const serve = fixtureFetch({ children: [...children] });

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      // The recorded handler matches on the path, and `fixtureFetch` parses what it is given
      // as an absolute URL — the authority is this server's own, and unused.
      const result = await serve(`http://127.0.0.1${request.url ?? '/'}`);
      const body = Buffer.from(await result.arrayBuffer());
      const headers: Record<string, string> = {};
      result.headers.forEach((value, key) => {
        headers[key] = value;
      });
      response.writeHead(result.status, headers);
      response.end(body);
    })().catch((error: unknown) => {
      process.stderr.write(`[zotero-fixture] ${String(error)}\n`);
      response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Electron's fetch keeps the connection alive, and `close` alone waits for it — which
        // is a hung teardown rather than a failure, and much harder to read.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
