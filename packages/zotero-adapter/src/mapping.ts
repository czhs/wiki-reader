/**
 * Zotero item -> wiki-reader document mapping (criterion T02).
 *
 * Everything here is pure: it takes wire records and returns plain values. No filesystem,
 * no database, no network. That is what lets the mapping tests run against recorded
 * fixtures and still prove the real behaviour.
 *
 * A Zotero *item key* never becomes an internal id. Keys travel through
 * `external_references`; internal ids are minted separately.
 */
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import type { Author, DocumentFileRole, DocumentType } from '@wr/shared-types';
import type { ZoteroCreator, ZoteroItem } from './wire.js';

/** Item types that are containers for other items rather than documents themselves. */
const NON_DOCUMENT_ITEM_TYPES = new Set(['attachment', 'note', 'annotation']);

export function isImportableItem(item: ZoteroItem): boolean {
  return !NON_DOCUMENT_ITEM_TYPES.has(item.data.itemType);
}

/**
 * A creator becomes a CSL-ish author.
 *
 * Zotero has two creator shapes: two-field (`firstName`/`lastName`) and single-field
 * (`name`, used for institutions). Single-field creators map to `literal` so that
 * "European Space Agency" is never rendered as a surname.
 */
export function mapCreator(creator: ZoteroCreator): Author | null {
  const family = creator.lastName?.trim() ?? '';
  const given = creator.firstName?.trim() ?? '';
  const literal = creator.name?.trim() ?? '';

  if (literal !== '') return { family: literal, literal };
  if (family === '' && given === '') return null;
  if (family === '') return { family: given };
  return given === '' ? { family } : { family, given };
}

/** Authors only — editors and translators are creators but not authors. */
export function mapAuthors(item: ZoteroItem): Author[] {
  const creators = item.data.creators ?? [];
  const authors = creators.filter((c) => c.creatorType === 'author');
  const source = authors.length > 0 ? authors : creators;
  return source.map(mapCreator).filter((a): a is Author => a !== null);
}

/**
 * Zotero dates are free text ("2015", "1987-04", "Sept 2 2025").
 *
 * `meta.parsedDate` is Zotero's own normalisation and is preferred when present; the raw
 * `data.date` is kept otherwise. Nothing here invents precision that the source lacks.
 */
export function mapPublishedDate(item: ZoteroItem): string | null {
  const parsed = item.meta?.parsedDate?.trim();
  if (parsed !== undefined && parsed !== '') return parsed;
  const raw = item.data.date?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

export function mapTitle(item: ZoteroItem): string {
  const title = item.data.title?.trim();
  if (title !== undefined && title !== '') return title;
  // Untitled records still need a stable, human-meaningful label in the sidebar.
  const url = item.data.url?.trim();
  if (url !== undefined && url !== '') return url;
  return `Untitled ${item.data.itemType} (${item.data.key})`;
}

export function mapAbstract(item: ZoteroItem): string | null {
  const abstract = item.data.abstractNote?.trim();
  return abstract === undefined || abstract === '' ? null : abstract;
}

export function mapTags(item: ZoteroItem): string[] {
  const names = (item.data.tags ?? []).map((t) => t.tag.trim()).filter((t) => t !== '');
  return [...new Set(names)].sort();
}

/**
 * The document type follows the *bytes we actually have*, not the bibliographic item type.
 *
 * A journal article with a PDF attachment is a `pdf`; the same article with only a web
 * snapshot is a `webpage`. This is what decides which reader panel opens it, so guessing
 * from `itemType` alone would open the wrong panel.
 */
export function mapDocumentType(item: ZoteroItem, attachments: readonly ZoteroItem[]): DocumentType {
  const contentTypes = attachments
    .filter((a) => attachmentHasBytes(a))
    .map((a) => a.data.contentType ?? '');

  if (contentTypes.includes('application/pdf')) return 'pdf';
  if (contentTypes.includes('text/html')) return 'webpage';

  switch (item.data.itemType) {
    case 'webpage':
    case 'blogPost':
    case 'forumPost':
      return 'webpage';
    case 'note':
      return 'note';
    default:
      return 'other';
  }
}

/** A `linked_url` attachment is a bookmark: there are no bytes to open, ever. */
export function attachmentHasBytes(attachment: ZoteroItem): boolean {
  const { linkMode } = attachment.data;
  return linkMode !== undefined && linkMode !== 'linked_url';
}

/**
 * File role within its document.
 *
 * The PDF is what the reader opens, so it is `primary`. An HTML snapshot alongside a PDF
 * is the archived original, kept for provenance. A snapshot with no PDF is that document's
 * primary artifact.
 */
export function mapFileRole(
  attachment: ZoteroItem,
  options: { readonly hasPdfSibling: boolean; readonly isFirstPdf: boolean },
): DocumentFileRole {
  const contentType = attachment.data.contentType ?? '';
  if (contentType === 'application/pdf') {
    return options.isFirstPdf ? 'primary' : 'supplementary';
  }
  if (contentType === 'text/html') {
    return options.hasPdfSibling ? 'original-snapshot' : 'primary';
  }
  return 'supplementary';
}

export interface ResolveAttachmentPathOptions {
  /** Zotero data directory, e.g. `~/Zotero`. Used for `imported_*` attachments. */
  readonly dataDir: string;
  /** Base directory configured for `attachments:` relative linked files, when set. */
  readonly linkedBaseDir?: string | undefined;
}

/**
 * The absolute path of an attachment's bytes, or null when it has none.
 *
 * Zotero reports the authoritative location in `links.enclosure.href` as a percent-encoded
 * `file://` URL; that is preferred because it already accounts for storage layout and for
 * base-directory relocation. The `<dataDir>/storage/<key>/<filename>` construction is the
 * documented fallback for when the enclosure link is absent.
 */
export function resolveAttachmentPath(
  attachment: ZoteroItem,
  options: ResolveAttachmentPathOptions,
): string | null {
  if (!attachmentHasBytes(attachment)) return null;

  const enclosure = attachment.links?.['enclosure']?.href;
  if (enclosure !== undefined && enclosure.startsWith('file://')) {
    try {
      return fileURLToPath(enclosure);
    } catch {
      // Fall through to reconstruction rather than dropping the attachment.
    }
  }

  const { linkMode, filename, path, key } = {
    linkMode: attachment.data.linkMode,
    filename: attachment.data.filename,
    path: attachment.data.path,
    key: attachment.data.key,
  };

  if (linkMode === 'linked_file') {
    if (path === undefined || path === '') return null;
    // Zotero writes `attachments:relative/path` when a base directory is configured.
    if (path.startsWith('attachments:')) {
      const relative = path.slice('attachments:'.length);
      return options.linkedBaseDir === undefined ? null : join(options.linkedBaseDir, relative);
    }
    return isAbsolute(path) ? path : null;
  }

  if (filename === undefined || filename === '') return null;
  return join(options.dataDir, 'storage', key, filename);
}

/** The fields an importer writes to `documents` for one Zotero item. */
export interface MappedDocument {
  readonly title: string;
  readonly docType: DocumentType;
  readonly authors: Author[];
  readonly abstract: string | null;
  readonly publishedDate: string | null;
  readonly source: 'zotero';
  readonly tags: string[];
  readonly collectionKeys: string[];
  readonly zoteroKey: string;
  readonly zoteroVersion: number;
}

export function mapItemToDocument(
  item: ZoteroItem,
  attachments: readonly ZoteroItem[] = [],
): MappedDocument {
  return {
    title: mapTitle(item),
    docType: mapDocumentType(item, attachments),
    authors: mapAuthors(item),
    abstract: mapAbstract(item),
    publishedDate: mapPublishedDate(item),
    source: 'zotero',
    tags: mapTags(item),
    collectionKeys: [...(item.data.collections ?? [])],
    zoteroKey: item.data.key,
    zoteroVersion: item.data.version,
  };
}
