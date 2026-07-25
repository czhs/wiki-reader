/**
 * The Zotero local API wire format.
 *
 * These schemas describe what Zotero 7 actually returns from
 * `http://127.0.0.1:23119/api/users/<id>/...`, recorded into
 * `test/fixtures/` from a real library rather than invented. Zotero adds fields between
 * versions and per item type, so every object is permissive about extra keys and strict
 * only about the fields the importer relies on.
 */
import { z } from 'zod';

/** `{ href, type, ... }` — Zotero decorates these differently per relation. */
const LinkSchema = z
  .object({
    href: z.string(),
    type: z.string().optional(),
    title: z.string().optional(),
    length: z.number().optional(),
    attachmentType: z.string().optional(),
    attachmentSize: z.number().optional(),
  })
  .passthrough();

export const ZoteroCreatorSchema = z
  .object({
    creatorType: z.string(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    /** Single-field creators ("Acme Corp") use `name` instead of first/last. */
    name: z.string().optional(),
  })
  .passthrough();
export type ZoteroCreator = z.infer<typeof ZoteroCreatorSchema>;

/**
 * How Zotero stores an attachment's bytes.
 *
 * - `imported_url` / `imported_file` — a copy inside the Zotero storage directory.
 * - `linked_file` — a file left where the user put it, referenced by path.
 * - `linked_url` — a bookmark. There are no bytes, so it can never become a file row.
 */
export const ZoteroLinkModeSchema = z.enum([
  'imported_url',
  'imported_file',
  'linked_url',
  'linked_file',
]);
export type ZoteroLinkMode = z.infer<typeof ZoteroLinkModeSchema>;

export const ZoteroItemDataSchema = z
  .object({
    key: z.string(),
    version: z.number().int().nonnegative(),
    itemType: z.string(),
    title: z.string().optional(),
    abstractNote: z.string().optional(),
    date: z.string().optional(),
    url: z.string().optional(),
    accessDate: z.string().optional(),
    libraryCatalog: z.string().optional(),
    publicationTitle: z.string().optional(),
    DOI: z.string().optional(),
    creators: z.array(ZoteroCreatorSchema).optional(),
    tags: z.array(z.object({ tag: z.string() }).passthrough()).optional(),
    collections: z.array(z.string()).optional(),
    dateAdded: z.string().optional(),
    dateModified: z.string().optional(),
    deleted: z.union([z.boolean(), z.number()]).optional(),

    // Attachment-only fields.
    parentItem: z.string().optional(),
    linkMode: ZoteroLinkModeSchema.optional(),
    contentType: z.string().optional(),
    filename: z.string().optional(),
    /** Present for `linked_file`; may use Zotero's `attachments:` base-directory prefix. */
    path: z.string().optional(),
    md5: z.string().nullable().optional(),
    mtime: z.number().nullable().optional(),
  })
  .passthrough();
export type ZoteroItemData = z.infer<typeof ZoteroItemDataSchema>;

export const ZoteroItemSchema = z
  .object({
    key: z.string(),
    version: z.number().int().nonnegative(),
    library: z
      .object({ type: z.string(), id: z.number(), name: z.string().optional() })
      .passthrough()
      .optional(),
    links: z.record(LinkSchema).optional(),
    meta: z
      .object({
        creatorSummary: z.string().optional(),
        parsedDate: z.string().optional(),
        numChildren: z.number().optional(),
      })
      .passthrough()
      .optional(),
    data: ZoteroItemDataSchema,
  })
  .passthrough();
export type ZoteroItem = z.infer<typeof ZoteroItemSchema>;

export const ZoteroCollectionSchema = z
  .object({
    key: z.string(),
    version: z.number().int().nonnegative(),
    data: z
      .object({
        key: z.string(),
        version: z.number().int().nonnegative(),
        name: z.string(),
        parentCollection: z.union([z.string(), z.literal(false)]).optional(),
      })
      .passthrough(),
    meta: z
      .object({
        numItems: z.number().optional(),
        numCollections: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ZoteroCollection = z.infer<typeof ZoteroCollectionSchema>;

export const ZoteroTagSchema = z
  .object({
    tag: z.string(),
    meta: z.object({ numItems: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();
export type ZoteroTag = z.infer<typeof ZoteroTagSchema>;

export const ZoteroItemListSchema = z.array(ZoteroItemSchema);
export const ZoteroCollectionListSchema = z.array(ZoteroCollectionSchema);
export const ZoteroTagListSchema = z.array(ZoteroTagSchema);

/** True when the item is an attachment that could have bytes on disk. */
export function isAttachment(item: ZoteroItem): boolean {
  return item.data.itemType === 'attachment';
}

/** Items Zotero keeps but the user has moved to the trash. */
export function isTrashed(item: ZoteroItem): boolean {
  const { deleted } = item.data;
  return deleted === true || deleted === 1;
}
