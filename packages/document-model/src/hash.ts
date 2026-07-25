/**
 * Content-change detection hashes for text.
 *
 * These are *not* cryptographic. They exist to answer "did this text change?" for
 * anchor invalidation, and they must run identically in the renderer and in the main
 * process. `node:crypto` is unavailable in the sandboxed renderer and `crypto.subtle`
 * is async, so we use a synchronous, dependency-free FNV-1a variant here.
 *
 * File content hashes (`DocumentFile.contentHash`) are SHA-256 and are computed only in
 * the main process, where `node:crypto` is available. Do not conflate the two.
 */

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * 64-bit FNV-1a over the UTF-16 code units of `input`, returned as 16 lowercase hex
 * characters. Stable across platforms and Node/Chromium.
 */
export function textHash(input: string): string {
  let hash = FNV_OFFSET_64;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // Mix both bytes of the code unit so that e.g. "Ā" and "" differ.
    hash = ((hash ^ BigInt(code & 0xff)) * FNV_PRIME_64) & MASK_64;
    hash = ((hash ^ BigInt((code >> 8) & 0xff)) * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Prefixed form used in persisted anchors, so the algorithm is identifiable later. */
export const TEXT_HASH_ALGORITHM = 'fnv1a64';

export function taggedTextHash(input: string): string {
  return `${TEXT_HASH_ALGORITHM}:${textHash(input)}`;
}
