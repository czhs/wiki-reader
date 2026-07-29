/**
 * Files added to the library from the disk directly (criteria N07, and B02 after it).
 *
 * Zotero is one source of documents, not the definition of the library. A file dropped on a
 * question's desk board — or, later, picked in the file dialog — becomes an ordinary document
 * with an ordinary `document_files` row pointing at **where it already is**. Nothing is
 * copied. A notebook that moved gigabytes of PDFs into a store of its own would have stopped
 * being local-first in the way that matters: the researcher's files would have two homes and
 * only one of them would be theirs.
 *
 * Not copying has a consequence that has to be paid for honestly. The `rrfile://` handler
 * refuses any path outside the allowed roots, and a file in `~/Downloads` is outside all of
 * them — so adding one **admits that exact path** and remembers it, which is what makes the
 * bytes readable afterwards. Admitting the containing folder would have been one line shorter
 * and would have turned "I want this paper" into "you may read everything beside it".
 *
 * The path itself only ever arrives from the operating system: a drop, handled in the
 * preload, or a native dialog. The renderer neither sends nor receives one, which is the
 * whole reason the drop is not an ordinary IPC channel.
 *
 * No Electron import, so the entire sequence runs under vitest against real files on disk.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { WikiReaderDatabase } from '@wr/database';
import type { Document, DocumentType } from '@wr/shared-types';
import type { Logger } from './logger.js';
import { resolveAllowedPath, type SwappableRoots } from './paths.js';

/** `Document.source` for anything added straight from disk. */
export const LOCAL_SOURCE = 'local';

/** Where the admitted paths are remembered between runs. */
export const ADMITTED_FILES_SETTING = 'library.admittedFiles';

/**
 * How many single files may be admitted.
 *
 * A cap because the list is a security surface: every entry is a path this process will read
 * bytes from, and an unbounded one grows silently for the life of the installation. Refusing
 * loudly at the limit is better than a list nobody can audit.
 */
export const MAX_ADMITTED_FILES = 2000;

const AdmittedFilesSchema = z.object({ paths: z.array(z.string().min(1)) });

/** How a file is understood, by extension. Unknown extensions are still admitted as files. */
const KNOWN_TYPES: Readonly<Record<string, { mimeType: string; docType: DocumentType }>> = {
  '.pdf': { mimeType: 'application/pdf', docType: 'pdf' },
  '.md': { mimeType: 'text/markdown; charset=utf-8', docType: 'markdown' },
  '.markdown': { mimeType: 'text/markdown; charset=utf-8', docType: 'markdown' },
  '.txt': { mimeType: 'text/plain; charset=utf-8', docType: 'other' },
  '.html': { mimeType: 'text/html; charset=utf-8', docType: 'webpage' },
  '.htm': { mimeType: 'text/html; charset=utf-8', docType: 'webpage' },
  '.png': { mimeType: 'image/png', docType: 'other' },
  '.jpg': { mimeType: 'image/jpeg', docType: 'other' },
  '.jpeg': { mimeType: 'image/jpeg', docType: 'other' },
  '.gif': { mimeType: 'image/gif', docType: 'other' },
  '.webp': { mimeType: 'image/webp', docType: 'other' },
  '.epub': { mimeType: 'application/epub+zip', docType: 'other' },
};

/** Why a file could not be added. The caller turns this into a message, never a path. */
export type AddFileFailure = 'not-a-file' | 'unreadable' | 'too-many-admitted';

export class AddFileError extends Error {
  constructor(readonly reason: AddFileFailure, message: string) {
    super(message);
    this.name = 'AddFileError';
  }
}

export interface AddedFile {
  readonly document: Document;
  /** False when this exact file was already in the library — dropping twice is not two papers. */
  readonly created: boolean;
}

export interface AddedFiles {
  /** The documents the files became, in the order they were given. */
  readonly documents: readonly Document[];
  /** How many of them are new library rows rather than files already known. */
  readonly created: number;
  /** Files that could not be added: a folder among them, or something unreadable. */
  readonly failed: number;
}

/**
 * Ask the operating system which files to add. Resolves to `null` when the dialog was
 * cancelled — or refused, which is what background mode does with a modal dialog.
 */
export type FileChooser = () => Promise<readonly string[] | null>;

export interface LocalFilesOptions {
  readonly db: WikiReaderDatabase;
  readonly roots: SwappableRoots;
  readonly logger?: Logger | undefined;
  /** Queue text extraction, so a dropped PDF is as searchable as an imported one. */
  readonly enqueueExtraction?: ((documentId: string) => void) | undefined;
  /**
   * Opens the native file dialog. Injected for the same reason the directory chooser is: the
   * dialog itself is the one part of this that needs Electron, and everything after it —
   * admitting the path, minting the document, queueing extraction — is the part worth testing.
   */
  readonly chooseFiles?: FileChooser | undefined;
}

export class LocalFileLibrary {
  readonly #db: WikiReaderDatabase;
  readonly #roots: SwappableRoots;
  readonly #logger: Logger | undefined;
  readonly #enqueueExtraction: ((documentId: string) => void) | undefined;
  readonly #chooseFiles: FileChooser | undefined;

  constructor(options: LocalFilesOptions) {
    this.#db = options.db;
    this.#roots = options.roots;
    this.#logger = options.logger?.child('local-files');
    this.#enqueueExtraction = options.enqueueExtraction;
    this.#chooseFiles = options.chooseFiles;
  }

  /**
   * Put the remembered admissions back in the allow-list.
   *
   * Called once at startup. Without it a file added yesterday is a library row whose bytes
   * this process refuses today — the `403 Forbidden` a stranded corpus produced, arrived at
   * from the other direction.
   */
  restore(): number {
    let restored = 0;
    for (const path of this.remembered()) {
      if (this.#roots.admit(path)) restored += 1;
    }
    if (restored > 0) this.#logger?.info('restored admitted files', { restored });
    return restored;
  }

  /** The paths this library has been given, as remembered between runs. */
  remembered(): readonly string[] {
    const parsed = AdmittedFilesSchema.safeParse(this.#db.settings.get(ADMITTED_FILES_SETTING));
    return parsed.success ? parsed.data.paths : [];
  }

  /**
   * Add one file to the library, where it lies.
   *
   * Idempotent by path: the same file dropped twice is one document, because a library that
   * grew a duplicate every time a hand slipped would be worse than one that refused.
   */
  async add(path: string): Promise<AddedFile> {
    if (!isAbsolute(path) || path.includes('\0')) {
      throw new AddFileError('not-a-file', 'a file is added by absolute path');
    }

    // Resolved through symlinks *before* anything is remembered, so what gets admitted is
    // what the OS will actually open — and a link cannot be re-aimed at another file later.
    const real = await realFile(path);

    const existing = this.#db.files.findByPath(real);
    const existingDocument =
      existing === null ? null : this.#db.documents.getById(existing.documentId);
    if (existingDocument !== null) {
      // Already known, but possibly from a run whose admission was never remembered.
      this.#admit(real);
      if (existingDocument.deletedAt !== null) {
        // It was taken out of the library, and adding it again is the researcher asking for
        // it back. Without this the file would be added to a library that goes on not showing
        // it — a drop that does nothing visible, which reads as a broken drop.
        this.#db.library.restore(existingDocument.id);
        // The removal dropped its search entries; the chunks and highlights behind them
        // survived, so putting it back is a re-projection the pipeline drains. Without this
        // the document returns to the library still unfindable, which is the same "it did
        // nothing visible" the restore above exists to prevent.
        this.#db.jobs.enqueue(existingDocument.id, 'index-fts');
        this.#logger?.info('a removed file was added again and restored', {
          documentId: existingDocument.id,
        });
        const restored = this.#db.documents.getById(existingDocument.id);
        if (restored !== null) return { document: restored, created: false };
      }
      return { document: existingDocument, created: false };
    }

    const info = await stat(real);
    const { mimeType, docType } = describe(real);
    this.#admit(real);

    const document = this.#db.documents.create({
      title: titleOf(real),
      docType,
      source: LOCAL_SOURCE,
      authors: [],
    });
    const contentHash = await hashFile(real);
    const { file } = this.#db.files.upsertByPath({
      documentId: document.id,
      path: real,
      mimeType,
      byteSize: info.size,
      contentHash,
      role: 'primary',
    });
    const { revision } = this.#db.revisions.createIfChanged({
      documentId: document.id,
      contentHash,
    });
    this.#db.files.setRevision(file.id, revision.id);

    // Same treatment an imported PDF gets: a dropped paper that never became searchable would
    // be a second class of document, distinguishable only by how it arrived.
    if (docType === 'pdf') this.#enqueueExtraction?.(document.id);

    this.#logger?.info('file added to the library', { documentId: document.id, docType });
    return { document, created: true };
  }

  /**
   * Add several files, keeping what worked.
   *
   * One bad file must not abandon the rest: a folder dragged in among the papers, or a file
   * whose bytes have gone, is reported and skipped. The report never carries the path — see
   * `AddFileError` — so a log line stays a record of what happened rather than a record of
   * where the researcher keeps their files.
   */
  async addMany(paths: readonly string[]): Promise<AddedFiles> {
    const documents: Document[] = [];
    let created = 0;
    let failed = 0;
    for (const path of paths) {
      try {
        const added = await this.add(path);
        documents.push(added.document);
        if (added.created) created += 1;
      } catch (error) {
        failed += 1;
        this.#logger?.warn('a file was not added', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { documents, created, failed };
  }

  /**
   * Open the file dialog and add what comes back (criterion B02).
   *
   * A cancelled dialog is not a failure and changes nothing, which is why the result carries
   * `chose` rather than throwing. Background mode refuses the dialog outright — an unattended
   * run has nobody to answer a modal — and that arrives here as a cancellation.
   */
  async addChosen(): Promise<AddedFiles & { chose: boolean }> {
    if (this.#chooseFiles === undefined) {
      this.#logger?.warn('no file chooser is wired up');
      return { chose: false, documents: [], created: 0, failed: 0 };
    }
    const picked = await this.#chooseFiles();
    if (picked === null || picked.length === 0) {
      return { chose: false, documents: [], created: 0, failed: 0 };
    }
    return { chose: true, ...(await this.addMany(picked)) };
  }

  /**
   * Remember a path and widen the allow-list by it.
   *
   * Both halves or neither: an admission that is not remembered stops working at the next
   * launch, and one that is remembered but not applied does nothing until then.
   */
  #admit(real: string): void {
    const remembered = this.remembered();
    if (remembered.includes(real)) {
      this.#roots.admit(real);
      return;
    }
    if (remembered.length >= MAX_ADMITTED_FILES) {
      throw new AddFileError(
        'too-many-admitted',
        `this library has already been given ${String(MAX_ADMITTED_FILES)} single files`,
      );
    }
    if (!this.#roots.admit(real)) {
      throw new AddFileError('not-a-file', 'a file is added by absolute path');
    }
    this.#db.settings.set(ADMITTED_FILES_SETTING, { paths: [...remembered, real] });
  }

  /** Whether the allow-list would let this path be read now. Used by the tests and the drop. */
  async readable(path: string): Promise<boolean> {
    return (await resolveAllowedPath(path, this.#roots)).ok;
  }
}

/** The path as the filesystem will report it, refusing anything that is not a regular file. */
async function realFile(path: string): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  let real: string;
  try {
    real = await realpath(path);
    info = await stat(real);
  } catch {
    throw new AddFileError('unreadable', 'that file could not be read');
  }
  if (!info.isFile()) throw new AddFileError('not-a-file', 'only a file can be added');
  return real;
}

/** Stream-hashed: a 300 MB PDF must not become a 300 MB buffer to be identified. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolve();
      });
  });
  return hash.digest('hex');
}

function describe(path: string): { mimeType: string; docType: DocumentType } {
  return (
    KNOWN_TYPES[extname(path).toLowerCase()] ?? {
      mimeType: 'application/octet-stream',
      docType: 'other',
    }
  );
}

/** The file's name without its extension, the way every notes app titles a file. */
function titleOf(path: string): string {
  const name = basename(path);
  const extension = extname(name);
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  return stem === '' ? name : stem;
}
