/**
 * @wr/zotero-adapter — read-only Zotero 7 local API client, mapping, and import.
 *
 * MAIN PROCESS ONLY. The renderer reaches this through IPC.
 *
 * The user's Zotero library is never written to: only GET requests are issued, and
 * `~/Zotero/zotero.sqlite` is never opened.
 */

export * from './wire.js';
export * from './client.js';
export * from './mapping.js';
export * from './importer.js';
