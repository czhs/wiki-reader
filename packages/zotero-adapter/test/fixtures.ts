import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ZoteroCollectionListSchema,
  ZoteroItemListSchema,
  ZoteroTagListSchema,
  type ZoteroCollection,
  type ZoteroItem,
  type ZoteroTag,
} from '../src/wire.js';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as unknown;

/**
 * Fixtures recorded from a real Zotero 7 local API, not invented.
 *
 * Parsing them through the same schemas the client uses means a drift between the
 * recorded shape and the parser fails the tests rather than passing silently.
 */
export const topItems = (): ZoteroItem[] => ZoteroItemListSchema.parse(read('items-top.json'));
export const childItems = (): ZoteroItem[] =>
  ZoteroItemListSchema.parse(read('items-children.json'));
export const collections = (): ZoteroCollection[] =>
  ZoteroCollectionListSchema.parse(read('collections.json'));
export const tags = (): ZoteroTag[] => ZoteroTagListSchema.parse(read('tags.json'));

export const childrenOf = (parentKey: string): ZoteroItem[] =>
  childItems().filter((child) => child.data.parentItem === parentKey);

export const itemByKey = (key: string): ZoteroItem => {
  const found = [...topItems(), ...childItems()].find((item) => item.data.key === key);
  if (found === undefined) throw new Error(`fixture item ${key} not found`);
  return found;
};
