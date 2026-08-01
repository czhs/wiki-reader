/**
 * A card-art cache, written before the app starts (criterion `B06`).
 *
 * The gallery is the one feature in this application that fetches anything, and the end-to-end
 * suite must not be the thing that makes it happen: a spec that reached Scryfall would depend on
 * a network the whole product exists to avoid, would be flaky on a train, and would prove
 * nothing about the criterion — which is about what the *picker* is, not about whether a remote
 * server is up.
 *
 * So the cache is seeded instead. The application keys everything it fetches by the SHA-256 of
 * the URL it built, and it will not fetch what it already has, so writing those files and the
 * `document_files` rows beside them is indistinguishable — from the app's point of view — from
 * an installation that fetched them last week. The URLs are computed with the application's own
 * `setListingUrl` and `artUrl`, never spelled out here: a seed that wrote its own idea of the
 * URL would silently stop matching the moment the real one changed, and the gallery would go
 * quietly empty rather than failing.
 *
 * This is the same shape as `seedNotebook`: only safe *before* `launchApp`, because Electron
 * must own the database file after that.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_ART_SOURCE, openDatabase } from '@wr/database';
import { artUrl, setListingUrl } from '../../../apps/desktop/src/main/card-art.js';
import type { E2EWorkspace } from './workspace.js';

/** A real 1×1 PNG. Real bytes, because the tile only reports a load if Chromium decoded them. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface SeededCard {
  readonly name: string;
  readonly artist: string;
}

/**
 * Illustrations from the set, in the order the gallery will show them.
 *
 * Real Modern Horizons 3 cards and their real illustrators, so what the spec asserts against is
 * the shape of the thing the researcher would actually see. Eight of them: more than one page of
 * the gallery, which is what makes "scroller" testable rather than assumed.
 */
export const SEEDED_CARDS: readonly SeededCard[] = [
  { name: 'Ajani, Nacatl Pariah', artist: 'Chris Rallis' },
  { name: 'Emrakul, the World Anew', artist: 'Chris Rahn' },
  { name: 'Flare of Denial', artist: 'Bryan Sola' },
  { name: 'Grief', artist: 'Kev Walker' },
  { name: 'Nurturing Pixie', artist: 'Jesper Ejsing' },
  { name: 'Phlage, Titan of Fire’s Fury', artist: 'Chris Rahn' },
  { name: 'Psychic Frog', artist: 'Rovina Cai' },
  { name: 'Wurmcoil Larva', artist: 'Jehan Choo' },
];

function stem(root: string, url: string): string {
  return join(root, createHash('sha256').update(url).digest('hex'));
}

/**
 * Put the set listing and every crop on disk, with the rows that let `rrfile://` serve them.
 *
 * The listing is written as the bytes a reply would carry, not as a shape of our own, so the
 * app's own parse runs over it. Each picture needs a `document_files` row for the same reason
 * every other image in this library does — a file id is the only way bytes reach a renderer.
 */
export function seedCardArtCache(
  workspace: E2EWorkspace,
  cards: readonly SeededCard[] = SEEDED_CARDS,
): void {
  const root = join(workspace.dir, 'card-art');
  mkdirSync(root, { recursive: true });

  writeFileSync(
    `${stem(root, setListingUrl())}.json`,
    JSON.stringify({
      object: 'list',
      total_cards: cards.length,
      has_more: false,
      data: cards.map((card) => ({ object: 'card', name: card.name, artist: card.artist })),
    }),
    'utf8',
  );

  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    const holder = db.documents.create({
      title: 'Card art',
      docType: 'other',
      source: CARD_ART_SOURCE,
      authors: [],
    }).id;
    for (const card of cards) {
      const path = `${stem(root, artUrl(card.name))}.png`;
      writeFileSync(path, PNG);
      db.files.upsertByPath({
        documentId: holder,
        path,
        mimeType: 'image/png',
        byteSize: PNG.byteLength,
        contentHash: createHash('sha256').update(PNG).digest('hex'),
        // Supplementary, like every fetched picture: this is not the document anybody opens.
        role: 'supplementary',
      });
    }
  } finally {
    db.close();
  }
}
