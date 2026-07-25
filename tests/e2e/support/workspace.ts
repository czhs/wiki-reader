/**
 * An isolated, disposable application workspace for the end-to-end suite.
 *
 * The application under test is never pointed at the developer's real library. Instead each
 * spec gets a temporary directory holding:
 *
 *   - a Zotero data directory laid out the way Zotero lays one out (`storage/<key>/<file>`),
 *     populated with real PDF bytes;
 *   - a SQLite database produced by running the *real* `ZoteroImporter` against the *real*
 *     `ZoteroLocalClient`, served the recorded local-API fixtures.
 *
 * That last point is what makes the M05 tag honest: the rows the sidebar renders were
 * genuinely created by the Zotero import path, not hand-inserted. The only thing adjusted in
 * the recorded fixtures is the `enclosure` href prefix, which is rewritten from the recorded
 * `/Users/testuser/Zotero` onto the temporary directory — the same relocation that happens
 * when a library is opened on a different machine.
 *
 * Seeding happens in this Node process and the database is closed before Electron starts, so
 * the two never hold the file open at once.
 */
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase, type WikiReaderDatabase } from '@wr/database';
import { ZoteroImporter, ZoteroLocalClient } from '@wr/zotero-adapter';
import { formatInternalLink } from '@wr/document-model';
import { fixtureFetch } from '../../../packages/zotero-adapter/test/fake-api.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE_PDF = join(REPO_ROOT, 'tests', 'fixtures', 'sample-paper.pdf');
const ZOTERO_FIXTURES = join(REPO_ROOT, 'packages', 'zotero-adapter', 'test', 'fixtures');

/** The data-directory prefix baked into the recorded `enclosure` hrefs. */
const RECORDED_DATA_DIR_URL = 'file:///Users/testuser/Zotero';

interface RecordedAttachment {
  readonly data: {
    readonly key: string;
    readonly itemType: string;
    readonly contentType?: string;
    readonly parentItem?: string;
  };
  readonly links?: Record<string, { href: string }>;
}

export interface SeededDocument {
  readonly id: string;
  readonly title: string;
}

export interface E2EWorkspace {
  readonly dir: string;
  readonly databasePath: string;
  readonly zoteroDataDir: string;
  /** Every document the import produced, in the order the library sidebar lists them. */
  readonly documents: readonly SeededDocument[];
  /** Documents whose primary file is a PDF that exists on disk. */
  readonly pdfDocuments: readonly SeededDocument[];
  /** A note containing a `document://` chip pointing at `linkTargetDocumentId`. */
  readonly noteId: string;
  readonly linkTargetDocumentId: string;
  /** Documents referenced by the seeded note, in link order. */
  readonly referencedDocumentIds: readonly string[];
  readonly dispose: () => void;
}

/** Read a recorded fixture file. */
async function loadFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(ZOTERO_FIXTURES, name), 'utf8')) as T;
}

/**
 * Rewrite the recorded `enclosure` hrefs onto `dataDir`.
 *
 * Only the directory prefix changes; the percent-encoded filename Zotero recorded is kept
 * exactly, so `resolveAttachmentPath` still has to decode it the way it does in production.
 */
function relocate(children: readonly RecordedAttachment[], dataDir: string): RecordedAttachment[] {
  const prefix = pathToFileURL(dataDir).href.replace(/\/$/, '');
  return children.map((child) => {
    const enclosure = child.links?.['enclosure']?.href;
    if (enclosure === undefined || !enclosure.startsWith(RECORDED_DATA_DIR_URL)) return child;
    return {
      ...child,
      links: {
        ...child.links,
        enclosure: { href: prefix + enclosure.slice(RECORDED_DATA_DIR_URL.length) },
      },
    };
  });
}

/**
 * Put real bytes where the relocated fixtures say the attachments are.
 *
 * PDFs get the fixture paper — a real, parseable document, so the reader is exercised rather
 * than its error path. HTML attachments get a small archived page: milestone 1 does not read
 * them, but leaving them absent would make the importer log missing-file warnings that have
 * nothing to do with what is under test.
 */
function materializeAttachments(children: readonly RecordedAttachment[]): void {
  for (const child of children) {
    const enclosure = child.links?.['enclosure']?.href;
    if (child.data.itemType !== 'attachment' || enclosure === undefined) continue;

    const path = fileURLToPath(enclosure);
    mkdirSync(dirname(path), { recursive: true });
    if (child.data.contentType === 'application/pdf') {
      copyFileSync(FIXTURE_PDF, path);
    } else {
      writeFileSync(
        path,
        '<!doctype html><meta charset="utf-8"><title>Archived page</title><p>Archived copy.</p>\n',
        'utf8',
      );
    }
  }
}

/**
 * A note whose body contains a real `documentLink` chip.
 *
 * Written as ProseMirror JSON rather than through the editor because the editor only exists
 * in the renderer. The flattened projection carries the canonical URL, which is what the
 * note editor's own serializer produces and what FTS5 indexes.
 */
function seedNote(db: WikiReaderDatabase, target: SeededDocument, second: SeededDocument): string {
  const targetUrl = formatInternalLink({ scheme: 'document', documentId: target.id });
  const secondUrl = formatInternalLink({ scheme: 'document', documentId: second.id });

  const note = db.notes.create({
    title: 'Reading list',
    contentJson: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Start with ' },
            { type: 'documentLink', attrs: { href: targetUrl, label: target.title } },
            { type: 'text', text: ', then ' },
            { type: 'documentLink', attrs: { href: secondUrl, label: second.title } },
            { type: 'text', text: '.' },
          ],
        },
      ],
    },
    contentText: `Start with ${targetUrl}, then ${secondUrl}.`,
  });

  // The typed edges the references panel reads. The note body and the links table are
  // written together here for the same reason the app writes both: the body is what the
  // reader sees, the edges are what "find all references" queries.
  for (const [ordinal, documentId] of [target.id, second.id].entries()) {
    db.links.create({
      type: 'mentions',
      sourceType: 'note',
      sourceId: note.id,
      targetType: 'document',
      targetId: documentId,
      ordinal,
      origin: 'derived',
      generator: 'note-content',
    });
  }

  return note.id;
}

export async function createWorkspace(): Promise<E2EWorkspace> {
  // `realpathSync` because macOS hands out `/var/folders/...` symlinks for the temp
  // directory. The path allow-list compares resolved paths without following symlinks, so
  // every path in play — the allowed root, the stored file paths — has to be the same form.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wr-e2e-')));
  const zoteroDataDir = join(dir, 'Zotero');
  const databasePath = join(dir, 'wiki-reader.db');
  mkdirSync(zoteroDataDir, { recursive: true });

  const recordedChildren = await loadFixture<RecordedAttachment[]>('items-children.json');
  const children = relocate(recordedChildren, zoteroDataDir);
  materializeAttachments(children);

  const { db } = openDatabase({ file: databasePath });
  try {
    const client = new ZoteroLocalClient({ fetch: fixtureFetch({ children }) });
    const summary = await new ZoteroImporter(client, db, { dataDir: zoteroDataDir }).import();
    if (summary.documentsCreated === 0) {
      throw new Error('e2e: the fixture import created no documents');
    }
    if (summary.filesMissing > 0) {
      throw new Error(
        `e2e: ${String(summary.filesMissing)} attachment(s) had no bytes: ${summary.warnings.join('; ')}`,
      );
    }

    const { items } = db.library.list({});
    const documents: SeededDocument[] = items.map((item) => ({
      id: item.document.id,
      title: item.document.title,
    }));
    const pdfDocuments = items
      .filter((item) => item.document.docType === 'pdf')
      .map((item) => ({ id: item.document.id, title: item.document.title }));

    const [first, second] = pdfDocuments;
    if (first === undefined || second === undefined) {
      throw new Error('e2e: the fixture library needs at least two PDF documents');
    }

    const noteId = seedNote(db, first, second);

    return {
      dir,
      databasePath,
      zoteroDataDir,
      documents,
      pdfDocuments,
      noteId,
      linkTargetDocumentId: first.id,
      referencedDocumentIds: [first.id, second.id],
      dispose: () => rmSync(dir, { recursive: true, force: true }),
    };
  } finally {
    // Electron must be the only process holding the database open once the spec starts.
    db.close();
  }
}
