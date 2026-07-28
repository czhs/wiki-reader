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
  /** The markdown corpus root handed to the app as `WR_MARKDOWN_ROOT`. */
  readonly corpusRoot: string;
  /**
   * Where the librarian keeps its workspace and its materialised wiki, handed to the app as
   * `WR_AGENT_ROOT`. A spec asserts against this directory directly: whether an accepted note
   * landed in it, and — the load-bearing one for `A03` — whether a wiki was written into it at
   * all while agents were off.
   */
  readonly agentRoot: string;
  /** The corpus page a spec opens, described by what the importer will make of it. */
  readonly corpusPage: CorpusPageExpectation;
  /** How many markdown files the corpus holds, and so how many rows its import adds. */
  readonly corpusPageCount: number;
  /** Every document the import produced, in the order the library sidebar lists them. */
  readonly documents: readonly SeededDocument[];
  /** Documents whose primary file is a PDF that exists on disk. */
  readonly pdfDocuments: readonly SeededDocument[];
  /** Documents whose primary file is an archived web page. */
  readonly webpageDocuments: readonly SeededDocument[];
  /** What that archived page renders, and what it must not be allowed to do. */
  readonly snapshot: SnapshotExpectation;
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
 * What a saved page in the workspace looks like, so a spec can assert on it without
 * re-deriving it from the markup below.
 */
export interface SnapshotExpectation {
  /** The `<h1>` the archived page renders. */
  readonly heading: string;
  /** A sentence in the body, present in the markup and nowhere else. */
  readonly bodyText: string;
  /** The font family the snapshot's *own* stylesheet applies to that heading. */
  readonly headingFontFamily: string;
  /** Natural width in pixels of the image the snapshot loads from beside itself. */
  readonly figureWidth: number;
  /** A remote URL the archived markup tries to fetch, which must never leave the machine. */
  readonly trackerUrl: string;
}

/** A 2x1 PNG, so a loaded image is distinguishable from a broken one by its dimensions. */
const FIGURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M+AFzCOKgAAaqgD/a4M+9UAAAAASUVORK5CYII=',
  'base64',
);

const SNAPSHOT_HEADING = 'How to become a mechanistic interpretability researcher';
const SNAPSHOT_BODY =
  'The first thing to understand is that the field rewards reading code more than reading papers.';
const SNAPSHOT_FONT = 'Georgia';
const SNAPSHOT_TRACKER = 'https://tracker.invalid/px.gif?read=interpretability';

/**
 * An archived page of the shape a real one has: an entry document that references its own
 * stylesheet and image by relative path, saved beside it.
 *
 * Written as separate files rather than inlined into the HTML precisely because that is what
 * W03 is about — a saved page that renders as the original has to *load* the things it was
 * saved with, over the same origin, through the protocol handler that bounds them to this
 * snapshot. A self-contained page would render identically and prove nothing.
 *
 * The tracking pixel and the remote script are there for the same reason: this is markup from
 * the open web, and the parts of it that phone home came along with the parts that don't.
 */
function writeSnapshot(entryPath: string): void {
  const dir = dirname(entryPath);
  mkdirSync(join(dir, 'assets', 'img'), { recursive: true });

  writeFileSync(
    join(dir, 'assets', 'page.css'),
    [
      `h1 { font-family: ${SNAPSHOT_FONT}, serif; }`,
      'body { margin: 0 auto; max-width: 40rem; }',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'assets', 'img', 'figure-1.png'), FIGURE_PNG);

  writeFileSync(
    entryPath,
    [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      `<title>${SNAPSHOT_HEADING}</title>`,
      '<link rel="stylesheet" href="assets/page.css">',
      `<script src="https://cdn.invalid/analytics.js"></script>`,
      '</head>',
      '<body>',
      `<h1 data-testid="snapshot-heading">${SNAPSHOT_HEADING}</h1>`,
      `<p>${SNAPSHOT_BODY}</p>`,
      '<img id="figure" src="assets/img/figure-1.png" alt="A diagram of a residual stream">',
      `<img id="tracker" src="${SNAPSHOT_TRACKER}" alt="" width="1" height="1">`,
      '<script>document.title = "scripts ran";</script>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * Put real bytes where the relocated fixtures say the attachments are.
 *
 * PDFs get the fixture paper — a real, parseable document, so the reader is exercised rather
 * than its error path. HTML attachments get a real archived page with its own stylesheet and
 * image, which is what the saved-page reader has to render.
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
      writeSnapshot(path);
    }
  }
}

/**
 * What the corpus page under test should look like once imported.
 *
 * Every field is something the *application* derives — the title from the first heading, the
 * slug from the filename — so a spec asserting on them is asserting that ingestion ran, not
 * that the fixture was copied.
 */
export interface CorpusPageExpectation {
  /** Markdown files in the corpus, counted here so a spec need not re-derive it. */
  readonly pageCount: number;
  readonly slug: string;
  readonly title: string;
  /** A sentence present in the file, used to prove the body rendered. */
  readonly bodyText: string;
  /** A wikilink target that exists in the corpus, and one that does not. */
  readonly resolvedLinkText: string;
  readonly wantedLinkText: string;
  /**
   * A page whose title is longer than any tab strip can show.
   *
   * Ordinary corpus markdown, ingested by the real importer like the others: `U03` is about
   * what a tab does with a title a person actually wrote, and a title injected into the store
   * would test the CSS against a string the app never produced.
   */
  readonly longTitle: string;
}

/**
 * Write a small wiki into the workspace.
 *
 * These are ordinary markdown files, not recorded fixtures: a corpus has no upstream service
 * to record from, and the importer reads the same bytes here that it would read from a real
 * Obsidian vault. Nothing pre-inserts rows — the app walks this folder at startup, so the
 * documents a spec sees were made by the real `MarkdownCorpusImporter`.
 */
function seedCorpus(root: string): CorpusPageExpectation {
  mkdirSync(root, { recursive: true });

  writeFileSync(
    join(root, 'spaced-repetition.md'),
    [
      '# Spaced repetition',
      '',
      'Recall is strongest when review is spread out rather than massed into one sitting.',
      '',
      '## Scheduling',
      '',
      'Intervals grow after each successful recall. See [[forgetting-curve]] for the shape',
      'this is fitted to, and [[desirable-difficulty]] for why the easy schedule is worse.',
      '',
      '```',
      'This [[fenced-link]] is code, not a link.',
      '```',
      '',
      'Written up in `notes.md`.',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    join(root, 'forgetting-curve.md'),
    [
      '# Forgetting curve',
      '',
      'Retention decays roughly exponentially with time since the last review.',
      '',
    ].join('\n'),
    'utf8',
  );

  const longTitle =
    'Why the interval between two reviews matters more than the total number of reviews, ' +
    'and what that implies for scheduling';

  writeFileSync(
    join(root, 'interval-versus-count.md'),
    [
      `# ${longTitle}`,
      '',
      'Two reviews a week apart beat four in an afternoon.',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    pageCount: 3,
    slug: 'spaced-repetition',
    title: 'Spaced repetition',
    bodyText: 'Recall is strongest when review is spread out',
    resolvedLinkText: 'forgetting-curve',
    wantedLinkText: 'desirable-difficulty',
    longTitle,
  };
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
  const corpusRoot = join(dir, 'corpus');
  // Made here rather than by the app, so a spec can assert that the *wiki* inside it is
  // absent without that assertion also passing for a workspace the app never reached.
  const agentRoot = join(dir, 'agent');
  mkdirSync(zoteroDataDir, { recursive: true });
  mkdirSync(agentRoot, { recursive: true });
  const corpusPage = seedCorpus(corpusRoot);

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
    // A `webpage` document is one whose bytes are a snapshot and not a PDF — `mapDocumentType`
    // prefers the PDF whenever an item has both, so these are the items saved from the web.
    const webpageDocuments = items
      .filter((item) => item.document.docType === 'webpage')
      .map((item) => ({ id: item.document.id, title: item.document.title }));

    const [first, second] = pdfDocuments;
    if (first === undefined || second === undefined) {
      throw new Error('e2e: the fixture library needs at least two PDF documents');
    }
    if (webpageDocuments.length === 0) {
      throw new Error('e2e: the fixture library needs at least one saved web page');
    }

    const noteId = seedNote(db, first, second);

    return {
      dir,
      databasePath,
      zoteroDataDir,
      corpusRoot,
      agentRoot,
      corpusPage,
      corpusPageCount: corpusPage.pageCount,
      documents,
      pdfDocuments,
      webpageDocuments,
      snapshot: {
        heading: SNAPSHOT_HEADING,
        bodyText: SNAPSHOT_BODY,
        headingFontFamily: SNAPSHOT_FONT,
        figureWidth: 2,
        trackerUrl: SNAPSHOT_TRACKER,
      },
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
