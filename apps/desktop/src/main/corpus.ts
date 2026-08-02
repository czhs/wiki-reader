/**
 * Markdown corpus ingestion.
 *
 * A wiki is a folder of markdown files, and this is the only way one enters the library. The
 * folder is configured in the main process — `WR_MARKDOWN_ROOT`, otherwise `<userData>/corpus`
 * — and never supplied by the renderer: "import this directory" arriving over IPC would hand
 * a compromised renderer an arbitrary-directory read, which is exactly the shape the rest of
 * the file boundary exists to prevent.
 *
 * Importing is idempotent and incremental. A file whose bytes are unchanged is not re-parsed,
 * re-chunked or re-indexed, so re-running over a large corpus costs a hash per file. Wikilinks
 * are resolved across the whole corpus at the end of a run rather than per file, because a
 * link is only unresolved once *every* page has been seen.
 *
 * No Electron import, so the whole importer runs under vitest against a real SQLite file and
 * real markdown on disk.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { WikiReaderDatabase } from '@wr/database';
import {
  parseMarkdown,
  resolveWikilinks,
  slugForFilename,
  type MarkdownWikilink,
  type WikilinkTarget,
} from '@wr/document-model';
import { SearchIndexer } from '@wr/search';
import type { CreateLinkInput } from '@wr/database';
import type { Logger } from './logger.js';
import { isInsideRoot, resolveAllowedPath, type AllowedRoots } from './paths.js';

/** The link type a `[[wikilink]]` produces, and the generator that owns those edges. */
export const WIKILINK_LINK_TYPE = 'document-references-document';
export const WIKILINK_GENERATOR = 'wikilink';

/** `Document.source` for everything ingested from the notes folder. */
export const CORPUS_SOURCE = 'corpus';

/** Extensions treated as corpus markdown. */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/** Directories never walked: version control, dependencies, and editor state. */
const SKIPPED_DIRECTORIES = new Set(['.git', '.obsidian', '.foam', 'node_modules', '.trash']);

export const MARKDOWN_MIME_TYPE = 'text/markdown; charset=utf-8';

export interface CorpusImportSummary {
  readonly root: string;
  readonly filesSeen: number;
  readonly documentsCreated: number;
  readonly documentsUpdated: number;
  readonly documentsUnchanged: number;
  readonly linksCreated: number;
  readonly wantedPages: number;
  readonly durationMs: number;
  readonly warnings: readonly string[];
}

export interface CorpusImporterOptions {
  readonly root: string;
  readonly allowed: AllowedRoots;
  readonly logger?: Logger | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * `Document.source` for everything this importer ingests. Defaults to the notes folder's.
   *
   * The demo library (`B07`) is the second folder of markdown this application ingests, and it
   * is made the same way real notes are — same walk, same parse, same wikilinks, same index —
   * so the only thing that can distinguish it afterwards is the tag on the row. One predicate
   * is then the whole of "clear the demo content", instead of a table remembering what was
   * made. Never used to ingest the researcher's own folder under another name.
   */
  readonly source?: string | undefined;
}

interface CorpusFile {
  readonly path: string;
  readonly documentId: string;
  readonly slug: string;
  readonly title: string;
  readonly wikilinks: readonly MarkdownWikilink[];
}

export class MarkdownCorpusImporter {
  readonly #db: WikiReaderDatabase;
  #root: string;
  readonly #allowed: AllowedRoots;
  readonly #logger: Logger | undefined;
  readonly #indexer: SearchIndexer;
  readonly #now: () => number;
  readonly #source: string;

  constructor(db: WikiReaderDatabase, options: CorpusImporterOptions) {
    this.#db = db;
    this.#root = options.root;
    this.#allowed = options.allowed;
    this.#logger = options.logger?.child('corpus');
    this.#now = options.now ?? ((): number => Date.now());
    this.#source = options.source ?? CORPUS_SOURCE;
    this.#indexer = new SearchIndexer(db);
  }

  /** The `Document.source` this importer writes. */
  get source(): string {
    return this.#source;
  }

  /** The folder currently being treated as the wiki. */
  get root(): string {
    return this.#root;
  }

  /**
   * Point the importer at a different folder.
   *
   * The allow-list is *not* updated here — it is shared with the file protocol and the
   * extraction pipeline, and this class has no business widening what they will read. The
   * caller swaps the root in both places, which is why `NotesFolder` owns the sequence.
   */
  setRoot(root: string): void {
    this.#root = root;
  }

  /**
   * Forget corpus documents whose file is not under the current root.
   *
   * Changing the notes folder is not a small edit to a preference: every row ingested from
   * the old folder now points at a file this app will refuse to open, and the reader sees a
   * list of notes that all fail with `403 Forbidden` when clicked. They are removed outright
   * rather than tombstoned — a file in a folder somebody stopped using is not a deleted note,
   * and a tombstone would resurrect it the moment anything listed deleted documents.
   *
   * Only `source = 'corpus'` rows are considered. A Zotero PDF on an unmounted volume is
   * temporarily unreachable, which is a different fact from "no longer part of this wiki",
   * and deleting those would lose annotations that are still wanted.
   */
  purgeOutsideRoot(): { readonly purged: number; readonly documentIds: readonly string[] } {
    const root = realRoot(this.#root);
    const stranded: string[] = [];

    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { items } = this.#db.documents.list({
        source: this.#source,
        includeDeleted: true,
        limit: pageSize,
        offset,
      });
      for (const document of items) {
        const files = this.#db.files.listByDocument(document.id);
        // No file at all is stranded too: there is nothing left to read, and the row would
        // sit in the notes list forever failing to open.
        const inside = files.some((file) => isInsideRoot(file.path, root));
        if (!inside) stranded.push(document.id);
      }
      if (items.length < pageSize) break;
    }

    if (stranded.length === 0) return { purged: 0, documentIds: [] };

    const purged = this.#db.transaction(() => {
      let count = 0;
      for (const documentId of stranded) {
        // `library.purge` owns the order and the membership: links address entities by id with
        // no foreign key so nothing cascades to them, annotations *do* cascade with the
        // document, and `search_entries` has no foreign key either — a stranded note that
        // still answered a query was the bug this loop's own copy of the list had.
        if (this.#db.library.purge(documentId).purged) count += 1;
      }
      return count;
    });

    this.#logger?.info('purged notes outside the current folder', { purged });
    return { purged, documentIds: stranded };
  }

  /**
   * Import every markdown file under the root.
   *
   * @param force re-parse and re-index even when the bytes are unchanged.
   */
  async import(options: { readonly force?: boolean } = {}): Promise<CorpusImportSummary> {
    const started = this.#now();
    const warnings: string[] = [];

    let paths: string[];
    try {
      paths = await this.#walk(this.#root);
    } catch (error) {
      // A missing corpus folder is the ordinary state of a fresh install, not a failure: the
      // user has not made a wiki yet. Report zero files rather than throwing at startup.
      this.#logger?.info('corpus root is unreadable', { root: this.#root, error: String(error) });
      return {
        root: this.#root,
        filesSeen: 0,
        documentsCreated: 0,
        documentsUpdated: 0,
        documentsUnchanged: 0,
        linksCreated: 0,
        wantedPages: 0,
        durationMs: this.#now() - started,
        warnings: [`corpus root is unreadable: ${this.#root}`],
      };
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const files: CorpusFile[] = [];

    for (const path of paths) {
      try {
        const outcome = await this.#ingestFile(path, options.force === true);
        if (outcome === null) continue;
        files.push(outcome.file);
        if (outcome.state === 'created') created += 1;
        else if (outcome.state === 'updated') updated += 1;
        else unchanged += 1;
      } catch (error) {
        // One unreadable file must not abandon the rest of the corpus. The path is reported
        // relative to the root: an absolute path in a renderer-visible warning would leak the
        // layout of the user's disk.
        warnings.push(`could not import ${relative(this.#root, path)}: ${messageOf(error)}`);
      }
    }

    const { linksCreated, wantedPages } = this.#syncWikilinks(files);

    const summary: CorpusImportSummary = {
      root: this.#root,
      filesSeen: paths.length,
      documentsCreated: created,
      documentsUpdated: updated,
      documentsUnchanged: unchanged,
      linksCreated,
      wantedPages,
      durationMs: this.#now() - started,
      warnings,
    };
    this.#logger?.info('corpus imported', { ...summary, warnings: warnings.length });
    return summary;
  }

  /** Every markdown file under `dir`, depth-first, in a stable order. */
  async #walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.#walk(path)));
        continue;
      }
      // `isFile()` is false for a symlink; resolution below decides whether a linked file is
      // inside the roots, so a link pointing out of the corpus is refused rather than read.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(path);
    }
    return out;
  }

  /** Read, hash, and (when the bytes moved) re-parse and re-index one file. */
  async #ingestFile(
    path: string,
    force: boolean,
  ): Promise<{ file: CorpusFile; state: 'created' | 'updated' | 'unchanged' } | null> {
    const resolved = await resolveAllowedPath(path, this.#allowed);
    if (!resolved.ok) {
      throw new Error(
        resolved.reason === 'outside-roots'
          ? 'resolves outside the allowed roots'
          : `unreadable: ${resolved.cause}`,
      );
    }
    const realPath = resolved.path;
    const info = await stat(realPath);
    if (!info.isFile()) return null;

    const source = await readFile(realPath, 'utf8');
    const contentHash = createHash('sha256').update(source, 'utf8').digest('hex');
    const parsed = parseMarkdown(source);
    const slug = slugForFilename(realPath);
    const title = parsed.title ?? fallbackTitle(realPath);

    const existingFile = this.#db.files.findByPath(realPath);
    const existingDocument =
      existingFile === null ? null : this.#db.documents.getById(existingFile.documentId);

    let state: 'created' | 'updated' | 'unchanged';
    let documentId: string;

    if (existingDocument === null) {
      const document = this.#db.documents.create({
        title,
        docType: 'markdown',
        source: this.#source,
        slug,
      });
      documentId = document.id;
      state = 'created';
    } else {
      documentId = existingDocument.id;
      const changed = existingFile?.contentHash !== contentHash;
      if (changed || existingDocument.title !== title || existingDocument.slug !== slug) {
        this.#db.documents.update(documentId, { title });
        this.#db.documents.setSlug(documentId, slug);
      }
      state = changed ? 'updated' : 'unchanged';
    }

    const file: CorpusFile = {
      path: realPath,
      documentId,
      slug,
      title,
      wikilinks: parsed.wikilinks,
    };

    if (state === 'unchanged' && !force) return { file, state };

    const { file: fileRow } = this.#db.files.upsertByPath({
      documentId,
      path: realPath,
      mimeType: MARKDOWN_MIME_TYPE,
      byteSize: info.size,
      contentHash,
      role: 'primary',
    });

    const { revision } = this.#db.revisions.createIfChanged({ documentId, contentHash });
    this.#db.files.setRevision(fileRow.id, revision.id);
    this.#db.revisions.setExtractedTextHash(revision.id, parsed.textHash);
    this.#indexer.indexExtractedChunks(documentId, revision.id, parsed.chunks);

    return { file, state };
  }

  /**
   * Turn the corpus's wikilinks into edges, and the rest into wanted pages.
   *
   * Resolution happens once the whole corpus is known: a link to a page imported later in the
   * same run is resolved, not recorded as wanted and then silently left stale.
   */
  #syncWikilinks(files: readonly CorpusFile[]): { linksCreated: number; wantedPages: number } {
    const index = new Map<string, WikilinkTarget>();
    for (const document of this.#db.documents.listSlugged()) {
      if (document.slug === null || index.has(document.slug)) continue;
      index.set(document.slug, {
        documentId: document.id,
        slug: document.slug,
        title: document.title,
      });
    }

    let linksCreated = 0;
    let wantedPages = 0;

    for (const file of files) {
      const { resolved, wanted } = resolveWikilinks(
        [{ documentId: file.documentId, wikilinks: file.wikilinks }],
        index,
      );

      const links: CreateLinkInput[] = resolved.map((entry, ordinal) => ({
        type: WIKILINK_LINK_TYPE,
        sourceType: 'document',
        sourceId: file.documentId,
        targetType: 'document',
        targetId: entry.target.documentId,
        label: entry.link.alias ?? entry.link.target,
        ordinal,
        ...(entry.link.section === null
          ? {}
          : { targetLocation: { kind: 'markdown' as const, headingPath: entry.link.section } }),
        metadata: { slug: entry.link.slug, headingPath: entry.link.headingPath },
      }));

      // Replaces only this generator's derived edges: a link the reader made by hand between
      // the same two documents is a different fact and survives re-indexing.
      linksCreated += this.#db.links.replaceDerived({
        sourceType: 'document',
        sourceId: file.documentId,
        generator: WIKILINK_GENERATOR,
        links,
      }).length;

      wantedPages += this.#db.wantedPages.replaceForDocument(
        file.documentId,
        wanted.map((page) => ({ slug: page.slug, title: page.title, count: page.count })),
      );
    }

    return { linksCreated, wantedPages };
  }
}

/**
 * The root as the filesystem will report it.
 *
 * Stored file paths are real paths — `#ingestFile` resolves every one through symlinks before
 * writing the row — so containment has to be decided against a real path too. On macOS
 * `/var/folders/…` is a symlink into `/private/var/folders/…`, and comparing the two forms
 * would find every document stranded and purge a corpus that had not moved.
 */
function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** A file with no `# heading` is titled by its name, the way Obsidian and Foam show it. */
function fallbackTitle(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
