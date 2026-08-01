/**
 * Card art — the second exception to local-first (criterion G05).
 *
 * The exception is bounded, and every bound is a separate way of getting this wrong, so each
 * one is asserted here rather than described in a comment: off until somebody turns it on,
 * the disclosure before the switch, one host and no other, image bytes and nothing else, and
 * a cache on disk so the same picture is fetched once in the life of the installation.
 *
 * The fetch is injected. That is not a convenience — a test that reached Scryfall would make
 * the suite depend on a network the whole application is built to avoid, and it would prove
 * nothing about the invariant that matters, which is *how many times* the app leaves the
 * machine and *where it goes*. Counting the calls is the assertion.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CARD_ART_HOST,
  CARD_ART_IMAGE_HOST,
  CARD_ART_SET,
  CARD_ART_SET_NAME,
} from '../../apps/desktop/src/main/card-art.js';
import { IntegrationWorkspace } from './support/workspace.js';

/** A real 1×1 PNG, the bytes a server would answer with. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Attempt {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * A server that records what was asked of it.
 *
 * Shared across a restart on purpose: the count has to span the whole life of the
 * installation, because a cache that only survives until the app quits is not a cache.
 */
class Server {
  readonly attempts: Attempt[] = [];
  /** What the next response says it is. Changed by the test that sends back a web page. */
  contentType = 'image/png';
  body: Buffer = PNG;

  /**
   * The set listing, and what the reply calls itself (`B06`).
   *
   * Held separately from the picture body because the two are different requests with different
   * gates — that separation is the whole of what this criterion added to the fetch path, and a
   * server that answered both with the same bytes could not tell whether it survived.
   */
  listingContentType = 'application/json';
  listing: unknown = {
    object: 'list',
    total_cards: 3,
    has_more: false,
    data: [
      { object: 'card', name: 'Phlage, Titan of Fire’s Fury', artist: 'Chris Rahn' },
      { object: 'card', name: 'Ajani, Nacatl Pariah', artist: 'Chris Rallis' },
      { object: 'card', name: 'Nurturing Pixie', artist: 'Jesper Ejsing' },
    ],
  };

  /**
   * Where the next replies send the caller instead of answering.
   *
   * Scryfall's `format=image` really is a redirect, so this is the shape of the live path and
   * not an invented one. Each entry is consumed by one attempt.
   */
  readonly redirects: string[] = [];

  readonly fetch = (url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    this.attempts.push({ url, headers: { ...init.headers } });
    const location = this.redirects.shift();
    if (location !== undefined) {
      return Promise.resolve(new Response(null, { status: 302, headers: { location } }));
    }
    if (new URL(url).pathname.endsWith('/cards/search')) {
      return Promise.resolve(
        new Response(JSON.stringify(this.listing), {
          status: 200,
          headers: { 'content-type': this.listingContentType },
        }),
      );
    }
    return Promise.resolve(
      new Response(this.body, { status: 200, headers: { 'content-type': this.contentType } }),
    );
  };

  /** Every request that asked for a picture rather than for the list of cards. */
  get artAttempts(): Attempt[] {
    return this.attempts.filter((attempt) => !attempt.url.includes('/cards/search'));
  }

  get listingAttempts(): Attempt[] {
    return this.attempts.filter((attempt) => attempt.url.includes('/cards/search'));
  }
}

class Workspace extends IntegrationWorkspace {
  readonly server: Server;

  constructor() {
    // Built before `super`, because the services this workspace opens with are wired to it —
    // a field would not exist yet when the base constructor opened them.
    const server = new Server();
    super('wr-card-art-', () => ({ cardArtFetch: server.fetch }));
    this.server = server;
  }
}

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(() => {
  workspace.dispose();
});

function seedDocument(title: string): string {
  return workspace.services.db.documents.create({
    title,
    docType: 'pdf',
    source: 'test',
    authors: [],
  }).id;
}

/** Read the disclosure and turn the switch on, the way the panel has to. */
async function enable(): Promise<void> {
  await workspace.call('cardArt:disclosure', {});
  await workspace.call('cardArt:enable', { enabled: true, acknowledgeDisclosure: true });
}

describe('card art', () => {
  it('[G05] is off by default, and asking for art while it is off makes no request', async () => {
    const documentId = seedDocument('Attention is all you need');

    const status = await workspace.call('cardArt:status', {});
    expect(status.enabled).toBe(false);
    expect(status.disclosureAcknowledged).toBe(false);

    const refused = await workspace.failure('cardArt:fetch', {
      entityType: 'document',
      entityId: documentId,
      name: 'Auriok Salvagers',
    });
    expect(refused.code).toBe('CONFLICT');
    // The assertion that matters: nothing left the machine.
    expect(workspace.server.attempts).toEqual([]);
  });

  it('[G05] cannot be enabled until the disclosure that names the host is acknowledged', async () => {
    const disclosure = await workspace.call('cardArt:disclosure', {});
    expect(disclosure.host).toBe(CARD_ART_HOST);
    expect(disclosure.acknowledged).toBe(false);
    // The host is named in the prose a person reads, not only in a field they never see.
    expect(disclosure.destination).toContain(CARD_ART_HOST);

    const refused = await workspace.failure('cardArt:enable', {
      enabled: true,
      acknowledgeDisclosure: false,
    });
    expect(refused.code).toBe('CONFLICT');
    expect((await workspace.call('cardArt:status', {})).enabled).toBe(false);

    const enabled = await workspace.call('cardArt:enable', {
      enabled: true,
      acknowledgeDisclosure: true,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.disclosureAcknowledged).toBe(true);
    // Still nothing has been fetched: enabling arms the feature, it does not use it.
    expect(workspace.server.attempts).toEqual([]);
  });

  it('[G05] fetches art from the one allow-listed host, carrying nothing about the researcher', async () => {
    const documentId = seedDocument('Attention is all you need');
    await enable();

    const fetched = await workspace.call('cardArt:fetch', {
      entityType: 'document',
      entityId: documentId,
      name: 'Auriok Salvagers',
    });
    expect(fetched.fromCache).toBe(false);

    expect(workspace.server.attempts).toHaveLength(1);
    const attempt = workspace.server.attempts[0];
    if (attempt === undefined) throw new Error('no request was made');
    expect(new URL(attempt.url).host).toBe(CARD_ART_HOST);
    expect(new URL(attempt.url).protocol).toBe('https:');
    // No cookie, no referrer, no user agent that says which application asked: the request
    // carries the card's name and nothing about who wanted it.
    const headerNames = Object.keys(attempt.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('cookie');
    expect(headerNames).not.toContain('referer');
    expect(headerNames).not.toContain('authorization');

    // The bytes reach the renderer the only way bytes ever do.
    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    const node = graph.nodes.find((entry) => entry.entityId === documentId);
    expect(node?.iconFileId).toBe(fetched.iconFileId);
    const row = workspace.services.db.files.getById(fetched.iconFileId);
    expect(row?.mimeType).toBe('image/png');
    expect(existsSync(row?.path ?? '')).toBe(true);
    // A file id, never a path — the same rule a local icon follows.
    expect(JSON.stringify(fetched)).not.toContain(workspace.dir);
  });

  it('[G05] follows the redirect to the image host it disclosed, and no further', async () => {
    const documentId = seedDocument('Attention is all you need');
    await enable();
    // The live shape: the API answers `format=image` with a redirect to the image CDN.
    workspace.server.redirects.push(`https://${CARD_ART_IMAGE_HOST}/art_crop/front/a/b.png`);

    const fetched = await workspace.call('cardArt:fetch', {
      entityType: 'document',
      entityId: documentId,
      name: 'Auriok Salvagers',
    });

    expect(fetched.fromCache).toBe(false);
    expect(workspace.server.attempts).toHaveLength(2);
    expect(new URL(workspace.server.attempts[0]?.url ?? '').host).toBe(CARD_ART_HOST);
    expect(new URL(workspace.server.attempts[1]?.url ?? '').host).toBe(CARD_ART_IMAGE_HOST);
    expect(workspace.services.db.files.getById(fetched.iconFileId)?.mimeType).toBe('image/png');
  });

  it('[G05] refuses a redirect that leaves the hosts the disclosure names', async () => {
    const documentId = seedDocument('Attention is all you need');
    await enable();
    // The whole point of an allow-list checked on the first hop only: the reply chooses the
    // host, and the bytes, the content type and the destination all come from somewhere the
    // researcher was never told about. `redirect: 'follow'` would make this request silently.
    workspace.server.redirects.push('https://art.example.com/tracking-pixel.png');

    const refused = await workspace.failure('cardArt:fetch', {
      entityType: 'document',
      entityId: documentId,
      name: 'Auriok Salvagers',
    });

    expect(refused.message).toContain(CARD_ART_HOST);
    // One attempt, not two: the request to the host it named was never made.
    expect(workspace.server.attempts).toHaveLength(1);
    expect(readdirSync(workspace.services.cardArt.root)).toHaveLength(0);
  });

  it('[G05] refuses a redirect that drops to http, or onto a port of its own', async () => {
    const documentId = seedDocument('Attention is all you need');
    await enable();

    for (const location of [
      `http://${CARD_ART_IMAGE_HOST}/a.png`,
      `https://${CARD_ART_IMAGE_HOST}:8443/a.png`,
    ]) {
      workspace.server.attempts.length = 0;
      workspace.server.redirects.length = 0;
      workspace.server.redirects.push(location);

      const refused = await workspace.failure('cardArt:fetch', {
        entityType: 'document',
        entityId: documentId,
        name: 'Auriok Salvagers',
      });

      expect(refused.code).toBe('INVALID_REQUEST');
      expect(workspace.server.attempts).toHaveLength(1);
    }
  });

  it('[G05] caches a fetched icon, so the second request never leaves the machine', async () => {
    const first = seedDocument('Attention is all you need');
    const second = seedDocument('Deep residual learning');
    await enable();

    const one = await workspace.call('cardArt:fetch', {
      entityType: 'document',
      entityId: first,
      name: 'Auriok Salvagers',
    });
    expect(workspace.server.attempts).toHaveLength(1);

    // The same art on a different node, and then again after the application has been
    // restarted: a cache that lives in memory would answer the first and not the second.
    const two = await workspace.call('cardArt:fetch', {
      entityType: 'document',
      entityId: second,
      name: 'Auriok Salvagers',
    });
    expect(two.fromCache).toBe(true);
    expect(two.iconFileId).toBe(one.iconFileId);

    workspace.restart();

    const three = await workspace.call('cardArt:fetch', {
      entityType: 'document',
      entityId: first,
      name: 'Auriok Salvagers',
    });
    expect(three.fromCache).toBe(true);
    expect(three.iconFileId).toBe(one.iconFileId);

    expect(workspace.server.attempts).toHaveLength(1);
    expect((await workspace.call('cardArt:status', {})).cached).toBe(1);
  });

  it('[G05] refuses a reply that is not an image, and caches nothing', async () => {
    const documentId = seedDocument('Attention is all you need');
    await enable();
    workspace.server.contentType = 'text/html; charset=utf-8';
    workspace.server.body = Buffer.from('<!doctype html><title>not a picture</title>');

    const refused = await workspace.failure('cardArt:fetch', {
      entityType: 'document',
      entityId: documentId,
      name: 'Auriok Salvagers',
    });
    expect(refused.code).toBe('INVALID_REQUEST');

    expect((await workspace.call('cardArt:status', {})).cached).toBe(0);
    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    expect(graph.nodes.find((entry) => entry.entityId === documentId)?.iconFileId).toBeNull();

    // And a refused reply is not left lying in the cache directory to be served later.
    const cache = join(workspace.dir, 'card-art');
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });

  it('[G05] switched off again, art already on a node stays and no new art is fetched', async () => {
    const documentId = seedDocument('Attention is all you need');
    await enable();
    const fetched = await workspace.call('cardArt:fetch', {
      entityType: 'document',
      entityId: documentId,
      name: 'Auriok Salvagers',
    });

    await workspace.call('cardArt:enable', { enabled: false, acknowledgeDisclosure: false });
    const refused = await workspace.failure('cardArt:fetch', {
      entityType: 'document',
      entityId: seedDocument('Deep residual learning'),
      name: 'Reflective Golem',
    });
    expect(refused.code).toBe('CONFLICT');
    expect(workspace.server.attempts).toHaveLength(1);

    // Turning it off stops it fetching. It does not take away a picture already chosen.
    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    expect(graph.nodes.find((entry) => entry.entityId === documentId)?.iconFileId).toBe(
      fetched.iconFileId,
    );

    // Turning it back on needs no second ceremony: the disclosure was read once.
    const back = await workspace.call('cardArt:enable', {
      enabled: true,
      acknowledgeDisclosure: false,
    });
    expect(back.enabled).toBe(true);
  });

  it('[G05] has a way in, and it is the disclosure before the switch', async () => {
    // The architectural half. A feature nothing points at is a feature nobody has, and a
    // *network* feature nothing points at is worse: the disclosure is the whole bargain, and
    // it is only offered if something offers it. The panel reads it, asks for the switch, and
    // asks for art by name — and it never spells a host or a scheme itself, because building a
    // URL in the renderer would put the choice of who to talk to on the wrong side of the
    // boundary that makes "one allow-listed host" true.
    const source = await readFile(
      fileURLToPath(new URL('../../apps/desktop/src/renderer/graph-panel.tsx', import.meta.url)),
      'utf8',
    );
    for (const channel of ['cardArt:disclosure', 'cardArt:enable', 'cardArt:fetch']) {
      expect(source, `the graph panel never calls ${channel}`).toContain(`call('${channel}'`);
    }
    expect(source, 'the renderer names a host').not.toContain('https://');
    expect(source, 'the renderer names the art host').not.toContain(CARD_ART_HOST);
  });

  it('[G05] keeps fetched art out of the picker of images the library holds', async () => {
    const documentId = seedDocument('Attention is all you need');
    await enable();
    await workspace.call('cardArt:fetch', {
      entityType: 'document',
      entityId: documentId,
      name: 'Auriok Salvagers',
    });

    // `graph:iconChoices` offers pictures the researcher put in the library. Art the app
    // fetched for itself is not one of those, and an icon picker that filled up with it would
    // make the library's own images harder to find with every node illustrated.
    expect((await workspace.call('graph:iconChoices', {})).choices).toEqual([]);
  });
});

/**
 * The gallery the icon picker is (criterion `B06`).
 *
 * The old control took a card's *name*, which meant the picker could only be used by someone
 * who already knew several hundred of them. A gallery has to get its list of illustrations from
 * somewhere, and that somewhere is a second shape of request — JSON rather than an image — so
 * every bound the picture path already had has to hold for it separately. That is what these
 * tests are: the listing is fetched once in the life of the installation, it is gated by its own
 * content type, it never reaches a host the disclosure does not name, and the pictures behind it
 * are still art crops asked for by name.
 */
describe('the Modern Horizons 3 gallery', () => {
  it('[B06] lists the set’s art and answers with file ids, never URLs', async () => {
    await enable();

    const page = await workspace.call('cardArt:gallery', { offset: 0, limit: 2 });
    expect(page.setName).toBe(CARD_ART_SET_NAME);
    expect(page.total).toBe(3);
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]?.name).toBe('Phlage, Titan of Fire’s Fury');
    expect(page.entries[0]?.artist).toBe('Chris Rahn');
    for (const entry of page.entries) {
      expect(entry.iconFileId).not.toBeNull();
      const row = workspace.services.db.files.getById(entry.iconFileId ?? '');
      expect(row?.mimeType).toBe('image/png');
      expect(existsSync(row?.path ?? '')).toBe(true);
    }
    // The renderer is told which file, never where it is or who answered — the same rule a
    // node's own icon follows, and the reason a graph's markup can carry neither.
    const answer = JSON.stringify(page);
    expect(answer).not.toContain(workspace.dir);
    expect(answer).not.toContain('https://');
    expect(answer).not.toContain(CARD_ART_HOST);

    // One request for the list, one per picture on the page asked for — and the page asked for
    // is a page, not the set. A gallery that fetched three hundred crops to show twelve would
    // be the opposite of the bound this feature is allowed to exist under.
    expect(workspace.server.listingAttempts).toHaveLength(1);
    expect(workspace.server.artAttempts).toHaveLength(2);
  });

  it('[B06] asks for the art crop alone, never a whole card', async () => {
    await enable();
    await workspace.call('cardArt:gallery', { offset: 0, limit: 3 });

    // The whole of "art only" as a mechanism: the picture URL is built in the main process from
    // a name, with the crop asked for explicitly, so no reply and no caller can turn it into a
    // request for the printed card. Every attempt is checked, not the first.
    expect(workspace.server.artAttempts).toHaveLength(3);
    for (const attempt of workspace.server.artAttempts) {
      const url = new URL(attempt.url);
      expect(url.host).toBe(CARD_ART_HOST);
      expect(url.searchParams.get('version')).toBe('art_crop');
      expect(url.searchParams.get('format')).toBe('image');
    }
    // And the listing asked for this set, in a stable order, once.
    const listing = new URL(workspace.server.listingAttempts[0]?.url ?? '');
    expect(listing.searchParams.get('q')).toContain(`set:${CARD_ART_SET}`);
    expect(listing.searchParams.get('order')).toBe('name');
    // It said what it was willing to be answered with, and that was not an image.
    expect(workspace.server.listingAttempts[0]?.headers['accept']).toBe('application/json');
  });

  it('[B06] fetches the listing once in the life of the installation', async () => {
    await enable();
    await workspace.call('cardArt:gallery', { offset: 0, limit: 1 });
    await workspace.call('cardArt:gallery', { offset: 1, limit: 1 });
    expect(workspace.server.listingAttempts).toHaveLength(1);

    // Across a restart, because a cache that lives in memory answers the second request and
    // not the second launch — the assertion the picture cache is already held to.
    workspace.restart();
    const again = await workspace.call('cardArt:gallery', { offset: 0, limit: 3 });
    expect(again.total).toBe(3);
    expect(workspace.server.listingAttempts).toHaveLength(1);
    // …and the pictures it names are the ones already here: three fetched, none refetched.
    expect(workspace.server.artAttempts).toHaveLength(3);
  });

  it('[B06] is refused while card art is off, and asks for nothing', async () => {
    const refused = await workspace.failure('cardArt:gallery', { offset: 0, limit: 12 });
    expect(refused.code).toBe('CONFLICT');
    // The assertion that matters, again: opening the picker is not what makes this application
    // talk to a server.
    expect(workspace.server.attempts).toEqual([]);
  });

  it('[B06] refuses a listing that is not JSON, and keeps nothing', async () => {
    await enable();
    workspace.server.listingContentType = 'text/html; charset=utf-8';

    const refused = await workspace.failure('cardArt:gallery', { offset: 0, limit: 3 });
    expect(refused.code).toBe('INVALID_REQUEST');
    // Nothing was written where `rrfile://` would be willing to serve it, and no picture was
    // asked for on the strength of a reply that was never a list of cards.
    expect(readdirSync(workspace.services.cardArt.root)).toHaveLength(0);
    expect(workspace.server.artAttempts).toEqual([]);
  });

  it('[B06] leaves a gap rather than an empty gallery when one picture cannot be had', async () => {
    await enable();
    // The picture path refuses this reply; the listing is unaffected. One illustration missing
    // must not be a panel that will not open.
    workspace.server.contentType = 'text/html; charset=utf-8';
    workspace.server.body = Buffer.from('<!doctype html><title>not a picture</title>');

    const page = await workspace.call('cardArt:gallery', { offset: 0, limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((entry) => entry.iconFileId)).toEqual([null, null]);
    expect(page.entries[0]?.name).toBe('Phlage, Titan of Fire’s Fury');
    expect((await workspace.call('cardArt:status', {})).cached).toBe(0);
  });

  it('[B06] discloses the listing before anything can be turned on', async () => {
    const disclosure = await workspace.call('cardArt:disclosure', {});
    // The list of cards is a request that leaves this machine, so it is named in the sentence a
    // person reads before the switch — not only in the code that makes it.
    expect(disclosure.sends.join(' ')).toContain(CARD_ART_SET_NAME);
    expect(disclosure.withholds.join(' ')).toContain('whole printed card');
    expect(workspace.server.attempts).toEqual([]);
  });
});
