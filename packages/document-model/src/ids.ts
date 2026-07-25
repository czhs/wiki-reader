import { ID_PREFIXES, type EntityKind } from '@wr/shared-types';

/**
 * ULID-style identifier minting.
 *
 * IDs are `<prefix>_<10 chars of timestamp><16 chars of randomness>` in Crockford base32,
 * lowercased. Lexicographic order matches creation order, which keeps `ORDER BY id` cheap
 * and gives stable pagination without a separate sort column.
 *
 * Uses Web Crypto, which is present in both Node 18+ and the sandboxed renderer.
 */

const ENCODING = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase, no i/l/o/u
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

function encodeTime(now: number): string {
  let remaining = now;
  let out = '';
  for (let i = TIME_LENGTH - 1; i >= 0; i -= 1) {
    const mod = remaining % 32;
    out = ENCODING[mod] + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    out += ENCODING[(bytes[i] ?? 0) % 32];
  }
  return out;
}

/** Generate the 26-character body of an identifier. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Mint a prefixed identifier for an entity kind. */
export function mintId(kind: EntityKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

/** The entity kind an ID belongs to, or `null` if the prefix is unknown. */
export function entityKindOf(id: string): EntityKind | null {
  const prefix = id.split('_')[0];
  if (prefix === undefined) return null;
  for (const [kind, value] of Object.entries(ID_PREFIXES)) {
    if (value === prefix) return kind as EntityKind;
  }
  return null;
}
