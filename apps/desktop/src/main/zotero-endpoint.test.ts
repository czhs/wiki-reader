/**
 * The one place a Zotero address can be configured, and what it refuses (criterion B05).
 *
 * The E2E suite points the importer at a fixture API on an ephemeral loopback port, which is
 * only honest because a moved Zotero port is real configuration a real installation needs. The
 * boundary that keeps it honest is here: a value that could send the library off the machine
 * is refused, and the built-in default stands.
 */
import { describe, expect, it } from 'vitest';
import { resolveZoteroEndpoint } from './zotero-endpoint.js';

describe('WR_ZOTERO_ENDPOINT', () => {
  it('[B05] accepts a loopback address, so a moved Zotero port can be named', () => {
    expect(resolveZoteroEndpoint('http://127.0.0.1:49711')).toEqual({
      endpoint: 'http://127.0.0.1:49711',
      refused: null,
    });
    expect(resolveZoteroEndpoint('http://localhost:23119/').endpoint).toBe('http://localhost:23119');
  });

  it('[B05] keeps the default when nothing is configured', () => {
    expect(resolveZoteroEndpoint(undefined)).toEqual({ endpoint: null, refused: null });
    expect(resolveZoteroEndpoint('   ')).toEqual({ endpoint: null, refused: null });
  });

  it('[B05] refuses anything that could send the library off this machine', () => {
    for (const value of [
      'http://example.invalid/',
      'https://127.0.0.1.evil.invalid/',
      'http://localhost.evil.invalid/',
      // Userinfo that reads as a loopback host to a careless string check.
      'http://127.0.0.1@evil.invalid/',
      'ftp://127.0.0.1/',
      'not a url',
    ]) {
      const decision = resolveZoteroEndpoint(value);
      expect(decision.endpoint, `${value} was admitted`).toBeNull();
      expect(decision.refused, `${value} was refused silently`).not.toBeNull();
    }
  });
});
