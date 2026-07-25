import { describe, expect, it } from 'vitest';
import {
  attachmentHasBytes,
  isImportableItem,
  mapAuthors,
  mapCreator,
  mapDocumentType,
  mapFileRole,
  mapItemToDocument,
  mapPublishedDate,
  mapTags,
  mapTitle,
  resolveAttachmentPath,
} from '../src/mapping.js';
import type { ZoteroItem } from '../src/wire.js';
import { childrenOf, itemByKey, topItems } from './fixtures.js';

const DATA_DIR = '/Users/testuser/Zotero';

/** Build a synthetic attachment for branches the recorded library does not contain. */
function attachment(data: Partial<ZoteroItem['data']> & { key: string }): ZoteroItem {
  return {
    key: data.key,
    version: 1,
    data: { version: 1, itemType: 'attachment', ...data },
  };
}

describe('[T02] Zotero item mapping', () => {
  it('[T02] maps a recorded preprint into a document with authors, date and type', () => {
    const item = itemByKey('438MK4WU');
    const mapped = mapItemToDocument(item, childrenOf('438MK4WU'));

    expect(mapped.title).toBe('Early Data Exposure Improves Robustness to Subsequent Fine-Tuning');
    expect(mapped.source).toBe('zotero');
    expect(mapped.zoteroKey).toBe('438MK4WU');
    expect(mapped.zoteroVersion).toBe(item.data.version);
    // The item is a `preprint`, but it has a PDF, so it opens in the PDF reader.
    expect(mapped.docType).toBe('pdf');
    expect(mapped.authors).toHaveLength(5);
    expect(mapped.authors[0]).toEqual({ family: 'Feng', given: 'Lawrence' });
    expect(mapped.publishedDate).toBe('2026');
    expect(mapped.abstract).not.toBeNull();
  });

  it('[T02] maps every recorded top-level item without losing its title or key', () => {
    const items = topItems();
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      const mapped = mapItemToDocument(item, childrenOf(item.data.key));
      expect(mapped.title.length).toBeGreaterThan(0);
      expect(mapped.zoteroKey).toBe(item.data.key);
      expect(['pdf', 'webpage', 'note', 'other']).toContain(mapped.docType);
      // A Zotero key must never leak into an internal id field.
      expect(mapped).not.toHaveProperty('id');
    }
  });

  it('[T02] prefers Zotero’s parsed date over the free-text date field', () => {
    // Recorded raw value is '2026-07-08T00:52:02Z'; meta.parsedDate is '2026-07-08'.
    expect(mapPublishedDate(itemByKey('TQKPJY5H'))).toBe('2026-07-08');
    // Recorded raw value is '2026' with parsedDate '2026' — partial precision is kept.
    expect(mapPublishedDate(itemByKey('PB3MVTT6'))).toBe('2026');
  });

  it('[T02] maps two-field and single-field creators differently', () => {
    expect(mapCreator({ creatorType: 'author', firstName: 'Naruya', lastName: 'Saitou' })).toEqual({
      family: 'Saitou',
      given: 'Naruya',
    });
    // Institutional creators must not be rendered as a surname.
    expect(mapCreator({ creatorType: 'author', name: 'European Space Agency' })).toEqual({
      family: 'European Space Agency',
      literal: 'European Space Agency',
    });
    expect(mapCreator({ creatorType: 'author' })).toBeNull();
  });

  it('[T02] keeps only authors when an item also has editors', () => {
    const item: ZoteroItem = {
      key: 'X',
      version: 1,
      data: {
        key: 'X',
        version: 1,
        itemType: 'book',
        creators: [
          { creatorType: 'editor', firstName: 'Ed', lastName: 'Editor' },
          { creatorType: 'author', firstName: 'Ann', lastName: 'Author' },
        ],
      },
    };
    expect(mapAuthors(item)).toEqual([{ family: 'Author', given: 'Ann' }]);
  });

  it('[T02] falls back to a stable label when an item has no title', () => {
    const untitled: ZoteroItem = {
      key: 'NOTITLE1',
      version: 3,
      data: { key: 'NOTITLE1', version: 3, itemType: 'document' },
    };
    expect(mapTitle(untitled)).toBe('Untitled document (NOTITLE1)');
  });

  it('[T02] derives the document type from the attachments, not the item type', () => {
    const webpage = itemByKey('AL2XD8VY');
    expect(webpage.data.itemType).toBe('webpage');
    // It carries a PDF, so it is a pdf document despite the `webpage` item type.
    expect(mapDocumentType(webpage, childrenOf('AL2XD8VY'))).toBe('pdf');

    const forumPost = itemByKey('VS7MANRS');
    expect(mapDocumentType(forumPost, childrenOf('VS7MANRS'))).toBe('webpage');

    // The same item with no attachments falls back to its bibliographic type.
    expect(mapDocumentType(forumPost, [])).toBe('webpage');
    expect(mapDocumentType(itemByKey('QU9C7W2S'), [])).toBe('other');
  });

  it('[T02] treats a linked_url bookmark as having no bytes', () => {
    const bookmark = itemByKey('MYS8IAZH');
    expect(bookmark.data.linkMode).toBe('linked_url');
    expect(attachmentHasBytes(bookmark)).toBe(false);
    expect(resolveAttachmentPath(bookmark, { dataDir: DATA_DIR })).toBeNull();

    // A bookmark must not make the parent look like a readable webpage.
    expect(mapDocumentType(itemByKey('QIQE79VI'), [bookmark])).toBe('other');
  });

  it('[T02] resolves an imported attachment path from the enclosure link', () => {
    const pdf = itemByKey('4HBDX8KT');
    const path = resolveAttachmentPath(pdf, { dataDir: DATA_DIR });
    // Zotero truncates long filenames on disk; the recorded value is the real one.
    expect(path).toBe(
      '/Users/testuser/Zotero/storage/4HBDX8KT/Saitou and Nei - 1987 - The neighbor-joining method a new method for reco.pdf',
    );
    // Percent-encoding in the recorded file:// URL must be decoded, not passed through.
    expect(path).not.toContain('%20');
  });

  it('[T02] reconstructs the storage path when no enclosure link is present', () => {
    const noEnclosure = attachment({
      key: 'ABCD1234',
      linkMode: 'imported_file',
      contentType: 'application/pdf',
      filename: 'paper.pdf',
    });
    expect(resolveAttachmentPath(noEnclosure, { dataDir: DATA_DIR })).toBe(
      '/Users/testuser/Zotero/storage/ABCD1234/paper.pdf',
    );
  });

  it('[T02] resolves linked files, including the attachments: base-directory prefix', () => {
    const absolute = attachment({
      key: 'LINK0001',
      linkMode: 'linked_file',
      contentType: 'application/pdf',
      path: '/Volumes/papers/thesis.pdf',
    });
    expect(resolveAttachmentPath(absolute, { dataDir: DATA_DIR })).toBe(
      '/Volumes/papers/thesis.pdf',
    );

    const relative = attachment({
      key: 'LINK0002',
      linkMode: 'linked_file',
      contentType: 'application/pdf',
      path: 'attachments:sub/thesis.pdf',
    });
    expect(
      resolveAttachmentPath(relative, { dataDir: DATA_DIR, linkedBaseDir: '/Volumes/base' }),
    ).toBe('/Volumes/base/sub/thesis.pdf');
    // Without a configured base directory the path is unresolvable, not guessed.
    expect(resolveAttachmentPath(relative, { dataDir: DATA_DIR })).toBeNull();
  });

  it('[T02] assigns file roles so exactly one PDF is primary', () => {
    const kids = childrenOf('QIQE79VI');
    const pdfs = kids.filter((k) => k.data.contentType === 'application/pdf');
    const html = kids.filter(
      (k) => k.data.contentType === 'text/html' && k.data.linkMode === 'imported_url',
    );
    expect(pdfs).toHaveLength(2);
    expect(html).toHaveLength(1);

    const first = pdfs[0];
    const second = pdfs[1];
    const snapshot = html[0];
    if (first === undefined || second === undefined || snapshot === undefined) {
      throw new Error('fixture shape changed');
    }

    expect(mapFileRole(first, { hasPdfSibling: true, isFirstPdf: true })).toBe('primary');
    expect(mapFileRole(second, { hasPdfSibling: true, isFirstPdf: false })).toBe('supplementary');
    // An HTML snapshot next to a PDF is provenance, not the thing the reader opens.
    expect(mapFileRole(snapshot, { hasPdfSibling: true, isFirstPdf: false })).toBe(
      'original-snapshot',
    );
    // The same snapshot with no PDF sibling is that document's primary artifact.
    expect(mapFileRole(snapshot, { hasPdfSibling: false, isFirstPdf: false })).toBe('primary');
  });

  it('[T02] excludes attachments and notes from the importable item set', () => {
    expect(isImportableItem(itemByKey('QIQE79VI'))).toBe(true);
    expect(isImportableItem(itemByKey('4HBDX8KT'))).toBe(false);
    expect(isImportableItem(itemByKey('A9FI9349'))).toBe(false);
  });

  it('[T02] de-duplicates and sorts tags', () => {
    const tagged: ZoteroItem = {
      key: 'T',
      version: 1,
      data: {
        key: 'T',
        version: 1,
        itemType: 'journalArticle',
        tags: [{ tag: 'phylogenetics' }, { tag: 'alignment' }, { tag: 'phylogenetics' }],
      },
    };
    expect(mapTags(tagged)).toEqual(['alignment', 'phylogenetics']);
  });
});
