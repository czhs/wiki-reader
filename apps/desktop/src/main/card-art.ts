/**
 * Card art — the second exception to local-first (criterion G05).
 *
 * A graph of forty discs is forty identical discs, and `G04` answered that with pictures the
 * library already holds. It leaves the researcher to find forty pictures. The alternative was
 * a local art library to search, and there is not one: the Cockatrice install on this machine
 * carries 29,267 cards and an empty `pics/`, because Cockatrice fetches art on demand too.
 *
 * So the app is allowed to fetch art, and the permission is bounded so tightly that the shape
 * of the local-first promise survives it:
 *
 * - **off by default**, and enabling is refused until the disclosure has been read — the same
 *   order agents follow, enforced here rather than in a component that could be re-arranged;
 * - **one host**, built in this module and never accepted from anywhere else. The renderer
 *   sends a card's *name*; a channel that took a URL would be a request-forgery hole aimed out
 *   of the main process;
 * - **image bytes only**, by an allow-list of four content types. SVG is deliberately absent:
 *   it carries script, and the whole point of `rrfile://` is that what comes back is a picture;
 * - **cached to disk**, keyed by the URL, so a picture is fetched once in the life of the
 *   installation — asserted by counting requests across a restart, because a cache that lives
 *   in memory answers the second request and not the second launch;
 * - **nothing about the researcher goes with it**: no cookie, no referrer, no credential.
 *
 * The bytes then reach the renderer the only way bytes ever do — `rrfile://<file id>`, which
 * means a fetched picture needs a `document_files` row like every other image. They hang off
 * one document with `source = 'card-art'`, not one per picture: forty icons would otherwise be
 * forty rows in a library that is supposed to hold what the researcher is working on.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CARD_ART_SOURCE, type WikiReaderDatabase } from '@wr/database';
import { CardArtGalleryEntrySchema } from '@wr/shared-types';
import type {
  CardArtDisclosure,
  CardArtGalleryEntry,
  CardArtStatus,
  LinkableEntityType,
} from '@wr/shared-types';
import type { Logger } from './logger.js';

/** The host this application asks for art. Named in the disclosure and in `README.md`. */
export const CARD_ART_HOST = 'api.scryfall.com';

/**
 * Where that host sends the bytes.
 *
 * `artUrl` asks the API for `format=image`, which answers with a redirect to Scryfall's image
 * CDN — so the picture has always come from here, and a bargain that named only the API was
 * describing a request the application does not actually make. It is named rather than
 * followed silently: "one allow-listed host" is a promise about where bytes come from, and a
 * redirect is the ordinary way that promise is broken without anyone editing the allow-list.
 */
export const CARD_ART_IMAGE_HOST = 'cards.scryfall.io';

/** Every host a card-art request may touch, on any hop. Nothing else is followed. */
export const CARD_ART_HOSTS: readonly string[] = [CARD_ART_HOST, CARD_ART_IMAGE_HOST];

/**
 * How many redirects are followed before the answer is refused.
 *
 * The real path is one hop. Three is slack for Scryfall changing its own routing, and a bound
 * so a redirect loop between two allowed hosts cannot spin.
 */
const MAX_REDIRECTS = 3;

/** One settings key, one JSON object: the switch and its acknowledgement move together. */
export const CARD_ART_SETTING = 'graph.cardArt';

/**
 * What a reply may be, and what it becomes on disk.
 *
 * An allow-list rather than a `image/` prefix test. `image/svg+xml` passes that test and is a
 * document with script in it; serving one over `rrfile://` would put executable content behind
 * an `<img>` element, which is exactly the thing the archived-HTML rules exist to prevent.
 */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * What a *listing* reply may be (criterion `B06`).
 *
 * Its own gate, deliberately narrow, and deliberately not added to `IMAGE_TYPES`. The image
 * gate is what stops a web page spending any time in a directory `rrfile://` is willing to
 * serve from, so widening it to admit JSON would trade that guarantee for one line saved. Two
 * kinds of reply, two gates, and the bytes they produce are kept apart on disk by extension.
 */
const LISTING_TYPES: ReadonlySet<string> = new Set(['application/json']);

/**
 * The largest reply that will be kept.
 *
 * A remote server decides how many bytes it sends; without a cap, one answer fills the disk.
 * Art crops run to tens of kilobytes, so this is three orders of magnitude of headroom and
 * still a bound.
 */
export const MAX_ART_BYTES = 8 * 1024 * 1024;

/**
 * The set the gallery offers, and its name in the sentence a person reads.
 *
 * One set rather than every card ever printed, because the gallery is a *scroller*: a list you
 * can reach the end of is a list you can choose from, and "all of Magic" is a search box with a
 * different problem. Modern Horizons 3 is one recent set of about three hundred illustrations,
 * which is a page or two of scrolling.
 */
export const CARD_ART_SET = 'mh3';
export const CARD_ART_SET_NAME = 'Modern Horizons 3';

/**
 * The set's cards, as the API lists them.
 *
 * `unique=art` collapses reprints and alternate frames onto one entry per illustration, which
 * is what a gallery of *art* means; `order=name` makes the scroll order the same on every
 * machine, so "the third one along" is a stable thing to have chosen.
 *
 * This is the one request in the application that asks for something other than a picture, and
 * it is a page of card names — no account, no library, nothing about the researcher.
 */
export function setListingUrl(): string {
  const url = new URL(`https://${CARD_ART_HOST}/cards/search`);
  url.searchParams.set('q', `set:${CARD_ART_SET} unique:art`);
  url.searchParams.set('order', 'name');
  url.searchParams.set('format', 'json');
  return url.toString();
}

/**
 * What is read back out of the listing, and nothing else.
 *
 * `passthrough` is deliberately absent: the reply carries prices, legality, rulings URIs and
 * forty other fields, none of which this application has any business keeping on disk or
 * sending to a renderer. A name and the illustrator's name are what a gallery shows.
 */
const ListingSchema = z.object({
  data: z
    .array(
      z.object({
        name: z.string().min(1),
        artist: z.string().default(''),
      }),
    )
    .default([]),
});

/** The statuses that mean "ask somewhere else". Everything else is the answer. */
const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** How long a request may take before it is abandoned. A hung socket must not hang a panel. */
const TIMEOUT_MS = 15_000;

const StoredCardArtSchema = z.object({
  enabled: z.boolean().default(false),
  /** When the disclosure was read and accepted. Null until it has been. */
  disclosureAcknowledgedAt: z.string().nullable().default(null),
});

export interface CardArtSettings {
  readonly enabled: boolean;
  readonly disclosureAcknowledgedAt: string | null;
}

export function defaultCardArtSettings(): CardArtSettings {
  return { enabled: false, disclosureAcknowledgedAt: null };
}

export function readCardArtSettings(db: WikiReaderDatabase): CardArtSettings {
  const parsed = StoredCardArtSchema.safeParse(db.settings.get(CARD_ART_SETTING));
  return parsed.success
    ? {
        enabled: parsed.data.enabled,
        disclosureAcknowledgedAt: parsed.data.disclosureAcknowledgedAt,
      }
    : defaultCardArtSettings();
}

/** Raised when something tries to switch card art on without the disclosure being accepted. */
export class CardArtDisclosureNotAcknowledgedError extends Error {
  constructor() {
    super('The disclosure has to be read before card art can be turned on.');
    this.name = 'CardArtDisclosureNotAcknowledgedError';
  }
}

/** Raised when art is asked for while the feature is off. Nothing is requested. */
export class CardArtDisabledError extends Error {
  constructor() {
    super('Card art is off, so nothing was fetched.');
    this.name = 'CardArtDisabledError';
  }
}

/** Raised when the reply is not one of the four image types, or is too large, or failed. */
export class CardArtRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardArtRefusedError';
  }
}

/**
 * Turn card art on or off.
 *
 * On requires the disclosure, now or previously. Off never does — a switch that takes a
 * ceremony to reach is a switch people leave on. Turning it back on afterwards needs no second
 * acknowledgement: the disclosure was read, and asking again would teach people to click past.
 */
export function setCardArtEnabled(
  db: WikiReaderDatabase,
  input: { readonly enabled: boolean; readonly acknowledgeDisclosure?: boolean },
  now: string,
): CardArtSettings {
  const current = readCardArtSettings(db);
  const next = ((): CardArtSettings => {
    if (!input.enabled) return { ...current, enabled: false };
    const acknowledgedAt =
      input.acknowledgeDisclosure === true ? now : current.disclosureAcknowledgedAt;
    if (acknowledgedAt === null) throw new CardArtDisclosureNotAcknowledgedError();
    return { enabled: true, disclosureAcknowledgedAt: acknowledgedAt };
  })();
  db.settings.set(CARD_ART_SETTING, {
    enabled: next.enabled,
    disclosureAcknowledgedAt: next.disclosureAcknowledgedAt,
  });
  return next;
}

/**
 * What a fetch would send, and where.
 *
 * Short, because there is little to say: a card's name goes out and a picture comes back. The
 * value of writing it down is that the host appears in the sentence a person reads, not only
 * in a field beside it that a panel might not render.
 */
export function cardArtDisclosure(
  db: WikiReaderDatabase,
  settings: CardArtSettings = readCardArtSettings(db),
): CardArtDisclosure {
  return {
    host: CARD_ART_HOST,
    headline:
      'Card art is fetched from the internet. Nothing leaves this machine until you turn it on.',
    destination: `Scryfall, at \`${CARD_ART_HOST}\`, over HTTPS — which sends the picture itself from \`${CARD_ART_IMAGE_HOST}\`. Those two hosts are the only ones this application will ask for art.`,
    sends: [
      `A request for the list of cards in ${CARD_ART_SET_NAME}, once, so the gallery has something to show. It is the same page everybody who opens the gallery asks for.`,
      'The name of the card whose art you asked for.',
      'Nothing else: no cookie, no referrer, no account, and nothing about your library.',
    ],
    withholds: [
      'Your documents, highlights, questions and notes. None of them are involved.',
      'Everything, while this is off: no request is made and no picture is looked up.',
      'A second request for a picture already fetched — it is kept on this disk and reused.',
      'The rest of the card. Only the illustration is asked for, never the whole printed card.',
    ],
    cached: cachedArtCount(db),
    acknowledged: settings.disclosureAcknowledgedAt !== null,
  };
}

export function cardArtStatus(
  db: WikiReaderDatabase,
  settings: CardArtSettings = readCardArtSettings(db),
): CardArtStatus {
  return {
    enabled: settings.enabled,
    disclosureAcknowledged: settings.disclosureAcknowledgedAt !== null,
    host: CARD_ART_HOST,
    cached: cachedArtCount(db),
  };
}

/** How many pictures this installation has fetched and kept. */
function cachedArtCount(db: WikiReaderDatabase): number {
  const holder = cardArtDocument(db);
  return holder === null ? 0 : db.files.listByDocument(holder).length;
}

/** The one document every cached picture hangs off, or null when nothing has been fetched. */
function cardArtDocument(db: WikiReaderDatabase): string | null {
  const found = db.documents.list({ source: CARD_ART_SOURCE, limit: 1, includeDeleted: true });
  return found.items[0]?.id ?? null;
}

/**
 * The request, as this application makes it.
 *
 * Injected for the same reason `zoteroFetch` is: a test that reached Scryfall would depend on
 * the network the whole application is built to avoid, and would prove nothing about the
 * invariant that matters — how many times the app leaves this machine, and where it goes.
 */
export interface CardArtRequestInit {
  readonly headers: Record<string, string>;
  /** Never `follow`: the hop is inspected here, so the answer cannot choose the next host. */
  readonly redirect: 'manual';
  readonly referrerPolicy: 'no-referrer';
  readonly credentials: 'omit';
  readonly signal: AbortSignal;
}

export type CardArtFetch = (url: string, init: CardArtRequestInit) => Promise<Response>;

export interface CardArtOptions {
  readonly db: WikiReaderDatabase;
  /** Where fetched pictures are kept. Inside the allow-list, so `rrfile://` can serve them. */
  readonly root: string;
  readonly fetch?: CardArtFetch | undefined;
  readonly logger?: Logger | undefined;
}

export interface FetchedArt {
  readonly fileId: string;
  /** False when this request left the machine. The second one for the same art is true. */
  readonly fromCache: boolean;
}

export class CardArtLibrary {
  readonly #db: WikiReaderDatabase;
  readonly #root: string;
  readonly #fetch: CardArtFetch;
  readonly #logger: Logger | undefined;

  constructor(options: CardArtOptions) {
    this.#db = options.db;
    this.#root = options.root;
    this.#fetch = options.fetch ?? defaultCardArtFetch;
    this.#logger = options.logger?.child('card-art');
  }

  get root(): string {
    return this.#root;
  }

  /**
   * Put the art for a named card on a node.
   *
   * The URL is built here from the one allowed host, so the only thing that crosses the IPC
   * boundary is a name. Everything else — where the picture is kept, what it is called on
   * disk, which host answered — stays where paths and hosts belong.
   */
  async illustrate(input: {
    readonly entityType: LinkableEntityType;
    readonly entityId: string;
    readonly name: string;
  }): Promise<FetchedArt> {
    const settings = readCardArtSettings(this.#db);
    // Checked before anything is built, so "off" means no request rather than a request that
    // is discarded. This is the assertion `G05` opens with.
    if (!settings.enabled) throw new CardArtDisabledError();

    const url = artUrl(input.name);
    const cached = this.#cached(url);
    const fileId =
      cached ?? (await this.#fetchAndKeep(url, input.name));

    this.#db.graph.setIcon(input.entityType, input.entityId, fileId);
    return { fileId, fromCache: cached !== null };
  }

  /**
   * A page of the set's art, ready to be drawn (criterion `B06`).
   *
   * The gallery is the icon picker: a strip of illustrations you scroll through and press,
   * rather than a field that asks you to already know a card's name — which was the old
   * control, and which nobody who was not already a Magic player could use at all.
   *
   * Two request shapes, in this order and no other:
   *
   * 1. the set listing, once per installation, cached on disk beside the pictures. It is JSON,
   *    so it goes through its own content-type gate and its own file — see `LISTING_TYPES`;
   * 2. the art crop for each name on the page being shown, through the *unchanged* `artUrl`
   *    path. Crops only: the URL is built here from a name, so no reply can talk this into
   *    fetching a whole card image, and a page already scrolled past costs nothing again.
   *
   * A crop that cannot be had is `null` rather than an error. One picture Scryfall has stopped
   * serving should leave a gallery with a gap in it, not an empty panel.
   */
  async gallery(input: {
    readonly offset: number;
    readonly limit: number;
  }): Promise<{ entries: CardArtGalleryEntry[]; total: number }> {
    // The same check `illustrate` opens with, in the same place: off means no request, and a
    // gallery that fetched a listing before anybody had turned anything on would be the
    // exception opening itself.
    if (!readCardArtSettings(this.#db).enabled) throw new CardArtDisabledError();

    const cards = await this.#listing();
    const page = cards.slice(input.offset, input.offset + input.limit);
    const entries: CardArtGalleryEntry[] = [];
    for (const card of page) {
      const url = artUrl(card.name);
      let fileId = this.#cached(url);
      if (fileId === null) {
        try {
          fileId = await this.#fetchAndKeep(url, card.name);
        } catch (error) {
          this.#logger?.warn('card art crop unavailable', {
            name: card.name,
            reason: error instanceof Error ? error.message : String(error),
          });
          fileId = null;
        }
      }
      entries.push(
        CardArtGalleryEntrySchema.parse({
          name: card.name,
          artist: card.artist,
          iconFileId: fileId,
        }),
      );
    }
    return { entries, total: cards.length };
  }

  /**
   * The set's cards, from disk if this installation has ever asked.
   *
   * Cached as the bytes that came back rather than as a shape of our own, so the file on disk
   * is the reply and re-reading it exercises the same parse a fresh fetch does. One listing is
   * a few hundred kilobytes and answers every gallery this installation will ever open.
   */
  async #listing(): Promise<{ name: string; artist: string }[]> {
    const url = setListingUrl();
    const path = `${this.#pathFor(url)}.json`;
    if (existsSync(path)) {
      try {
        return ListingSchema.parse(JSON.parse(await readFile(path, 'utf8'))).data;
      } catch {
        // A truncated or hand-edited cache file is a reason to ask again, not to fail: the
        // alternative leaves the gallery permanently broken with no way back short of finding
        // a directory the renderer is never told the name of.
        this.#logger?.warn('card art listing cache unreadable', { set: CARD_ART_SET });
      }
    }

    const response = await this.#request(url, LISTING_TYPES);
    if (!response.ok) {
      throw new CardArtRefusedError(`${CARD_ART_HOST} answered ${String(response.status)}`);
    }
    // The gate, before a byte is written — for the reason the image gate exists. A reply that
    // is a web page must not land in the cache directory whatever it claims to be a listing of.
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!LISTING_TYPES.has(contentType.toLowerCase())) {
      throw new CardArtRefusedError(
        `the list of cards has to be JSON, and that reply was ${contentType}`,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ART_BYTES) {
      throw new CardArtRefusedError(`that listing is larger than ${String(MAX_ART_BYTES)} bytes`);
    }
    let parsed: { name: string; artist: string }[];
    try {
      parsed = ListingSchema.parse(JSON.parse(bytes.toString('utf8'))).data;
    } catch {
      throw new CardArtRefusedError('that reply was not a list of cards');
    }

    await mkdir(this.#root, { recursive: true });
    await writeFile(path, bytes);
    this.#logger?.info('card art listing fetched', {
      set: CARD_ART_SET,
      cards: parsed.length,
      host: CARD_ART_HOST,
    });
    return parsed;
  }

  /**
   * The picture for this URL, if it is already here.
   *
   * Both halves have to hold: a row *and* the bytes it names. A cache directory emptied by
   * hand would otherwise leave every node pointing at a file `rrfile://` refuses, for ever,
   * with no way back short of editing the database.
   */
  #cached(url: string): string | null {
    const path = this.#pathFor(url);
    const existing = candidatePaths(path).find((candidate) => existsSync(candidate));
    if (existing === undefined) return null;
    const row = this.#db.files.findByPath(existing);
    return row?.id ?? null;
  }

  async #fetchAndKeep(url: string, name: string): Promise<string> {
    const response = await this.#request(url);
    if (!response.ok) {
      throw new CardArtRefusedError(`${CARD_ART_HOST} answered ${String(response.status)}`);
    }

    // The content type decides before a single byte is written: a reply that is a web page
    // must not spend any time in the cache directory where `rrfile://` could serve it.
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const extension = IMAGE_TYPES[contentType.toLowerCase()];
    if (extension === undefined) {
      throw new CardArtRefusedError(`card art has to be an image, and that reply was ${contentType}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new CardArtRefusedError('that reply had no bytes in it');
    if (bytes.byteLength > MAX_ART_BYTES) {
      throw new CardArtRefusedError(`that picture is larger than ${String(MAX_ART_BYTES)} bytes`);
    }

    const path = `${this.#pathFor(url)}${extension}`;
    await mkdir(this.#root, { recursive: true });
    await writeFile(path, bytes);

    const documentId = this.#holder();
    const { file } = this.#db.files.upsertByPath({
      documentId,
      path,
      mimeType: contentType.toLowerCase(),
      byteSize: bytes.byteLength,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      // Supplementary, not primary: this is a picture the app went and got, not the document
      // anybody opens. `primaryForDocument` on the holder would otherwise answer at random.
      role: 'supplementary',
    });
    this.#logger?.info('card art fetched', { name, bytes: bytes.byteLength, host: CARD_ART_HOST });
    return file.id;
  }

  /**
   * Fetch, following redirects by hand.
   *
   * `redirect: 'follow'` would let the *answer* choose the host: the allow-list is checked
   * against the URL this code built, and a `Location` header pointing anywhere at all is then
   * followed by fetch itself, with the bytes and the content type taken from wherever it
   * landed. Since the request Scryfall actually answers is a redirect, that is not a
   * theoretical hole — it is the normal path. Every hop is checked here instead, so the
   * allow-list means what the disclosure says it means.
   *
   * `accepts` is what this particular request is willing to be answered with — the four image
   * types, or the one listing type. It is the *asked-for* half only; the reply is gated again
   * by the caller against the same set, because a server is free to ignore an `accept` header.
   */
  async #request(url: string, accepts: Iterable<string> = Object.keys(IMAGE_TYPES)): Promise<Response> {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      this.#assertAllowed(target);

      let response: Response;
      try {
        response = await this.#fetch(target, {
          // `accept` is the only header, and it says what a reply may be rather than who asked.
          headers: { accept: [...accepts].join(', ') },
          redirect: 'manual',
          referrerPolicy: 'no-referrer',
          credentials: 'omit',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new CardArtRefusedError(
          `${CARD_ART_HOST} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!REDIRECT_STATUS.has(response.status)) return response;
      if (hop >= MAX_REDIRECTS) {
        throw new CardArtRefusedError('that request was redirected too many times');
      }

      const location = response.headers.get('location');
      if (location === null || location.trim() === '') {
        throw new CardArtRefusedError('that reply redirected without saying where');
      }
      // Resolved against the URL that answered, because a `Location` may be relative — and
      // relative is how a hop stays on an allowed host, so it must not be refused outright.
      try {
        target = new URL(location, target).toString();
      } catch {
        throw new CardArtRefusedError('that reply redirected somewhere that is not a URL');
      }
    }
  }

  /** The allow-list, applied to one hop. Scheme included: a redirect may propose `http:`. */
  #assertAllowed(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CardArtRefusedError('card art needs a URL to ask for');
    }
    if (parsed.protocol !== 'https:') {
      throw new CardArtRefusedError('card art is fetched over HTTPS and nothing else');
    }
    // `host`, not `hostname`: a port is part of who is being asked, so `api.scryfall.com:8443`
    // is a different destination and is refused rather than quietly allowed.
    if (!CARD_ART_HOSTS.includes(parsed.host)) {
      throw new CardArtRefusedError(
        `card art comes from ${CARD_ART_HOSTS.join(' or ')} and nowhere else`,
      );
    }
  }

  /** The one document cached pictures hang off, made on the first fetch and reused after. */
  #holder(): string {
    const existing = cardArtDocument(this.#db);
    if (existing !== null) return existing;
    return this.#db.documents.create({
      title: 'Card art',
      docType: 'other',
      source: CARD_ART_SOURCE,
      authors: [],
    }).id;
  }

  /** Keyed by the URL, so the same art asked for twice is the same file — extension aside. */
  #pathFor(url: string): string {
    return join(this.#root, createHash('sha256').update(url).digest('hex'));
  }
}

/** The four names a cached picture could have, since the extension came from the reply. */
function candidatePaths(stem: string): string[] {
  return Object.values(IMAGE_TYPES).map((extension) => `${stem}${extension}`);
}

/**
 * The art for a named card, on the one allowed host.
 *
 * `version=art_crop` asks for the illustration without the frame and rules text, which is the
 * part that reads at the size a graph node is drawn.
 */
export function artUrl(name: string): string {
  const url = new URL(`https://${CARD_ART_HOST}/cards/named`);
  url.searchParams.set('exact', name);
  url.searchParams.set('format', 'image');
  url.searchParams.set('version', 'art_crop');
  return url.toString();
}

/** The real request. Everything about it is set explicitly rather than left to a default. */
const defaultCardArtFetch: CardArtFetch = (url, init) => fetch(url, init);
