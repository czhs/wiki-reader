/**
 * The integration harness: a real database, the real router, in a real temp directory.
 *
 * Every integration test wants the same three things — a fresh SQLite file nobody shares, a way
 * to send a request the way the renderer would (through `dispatch`, so the channel's zod schema
 * runs before any handler sees it), and a restart that closes everything and reopens against the
 * same file. Eight files had written that class out, and they had already begun to differ: some
 * carried a doc comment on `restart` and some did not, some called the failure path `attempt` and
 * one called it `failure`, and a change to how services are opened would have had to be made
 * eight times with seven chances to miss one.
 *
 * What is genuinely per-test is which services to open with — recorded Zotero fixtures, a stub
 * card-art fetcher, a corpus root — so that is a callback rather than a subclass hook: it is
 * handed the temp directory, which is the one thing it cannot know in advance, and it runs on
 * every open so a restart gets the same wiring.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcChannel, IpcRequest, IpcResponse } from '@wr/shared-types';
import {
  createTestServices,
  type AppServices,
  type CreateServicesOptions,
} from '../../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../../apps/desktop/src/main/logger.js';

/** Extra service wiring for one test file, given the temp directory it will run in. */
export type ServiceOverrides = (dir: string) => Partial<CreateServicesOptions>;

export class IntegrationWorkspace {
  readonly dir: string;
  readonly databasePath: string;
  #services: AppServices;

  constructor(
    prefix: string,
    private readonly overrides: ServiceOverrides = () => ({}),
  ) {
    this.dir = mkdtempSync(join(tmpdir(), prefix));
    this.databasePath = join(this.dir, 'wiki-reader.db');
    this.#services = this.#open();
  }

  #open(): AppServices {
    return createTestServices({
      databasePath: this.databasePath,
      zoteroDataDir: join(this.dir, 'zotero'),
      ...this.overrides(this.dir),
    });
  }

  get services(): AppServices {
    return this.#services;
  }

  /** Close everything and reopen against the same file — an application restart. */
  restart(): void {
    this.#services.close();
    this.#services = this.#open();
  }

  /** Send a request the way the renderer would: through the router and its validation. */
  async call<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
    const result = await dispatch(createHandlers(this.#services), channel, request, silentLogger);
    if (!result.ok) {
      throw new Error(`ipc ${channel} failed: ${result.error.code} ${result.error.message}`);
    }
    return result.value as IpcResponse<K>;
  }

  /** The raw envelope, for the cases where the refusal *is* the assertion. */
  async attempt(channel: string, request: unknown): Promise<ReturnType<typeof dispatch>> {
    return dispatch(createHandlers(this.#services), channel, request, silentLogger);
  }

  /** The same request, kept as its failure. */
  async failure<K extends IpcChannel>(
    channel: K,
    request: IpcRequest<K>,
  ): Promise<{ code: string; message: string }> {
    const result = await this.attempt(channel, request);
    if (result.ok) throw new Error(`ipc ${channel} was expected to fail and did not`);
    return { code: result.error.code, message: result.error.message };
  }

  dispose(): void {
    this.#services.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
