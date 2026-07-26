/**
 * Which folder the notes come from, and what happens when it changes.
 *
 * The folder is chosen *in the app* — a native directory dialog owned by the main process —
 * and remembered in `settings`. The renderer never names it and never learns it: it asks for
 * the choice to be made, and gets back the folder's display name and what the switch did.
 * That keeps the rule the rest of the file boundary is built on ("the renderer neither sends
 * nor receives a filesystem path") intact for a feature whose whole subject is a path.
 *
 * Changing the folder is four things in one motion, and the order matters:
 *
 *   1. remember it, so a restart comes back to the same wiki;
 *   2. swap it into the allow-list, so its files can be read and the old folder's cannot;
 *   3. purge the documents ingested from the folder that is no longer in use — otherwise the
 *      notes list keeps rows whose bytes `rrfile://` will now refuse, which is precisely the
 *      `403 Forbidden` a stale corpus produced;
 *   4. import the new folder.
 *
 * No Electron import: the directory chooser is injected, so the whole sequence runs under
 * vitest against real folders on disk and a real database.
 */
import { basename, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { z } from 'zod';
import type { WikiReaderDatabase } from '@wr/database';
import type { MarkdownCorpusImporter } from './corpus.js';
import type { SwappableRoots } from './paths.js';
import type { Logger } from './logger.js';

/** Settings key holding the notes folder. */
export const NOTES_FOLDER_SETTING = 'notes.folder';

const StoredNotesFolderSchema = z.object({ path: z.string().min(1) });

/** Ask the user for a directory. Resolves to `null` when the dialog is cancelled. */
export type DirectoryChooser = () => Promise<string | null>;

export interface NotesFolderStatus {
  /** The folder's display name. Never a path — see the module comment. */
  readonly folderName: string;
  /** True once a folder has been chosen in the app rather than inherited from configuration. */
  readonly chosenInApp: boolean;
  /** How many notes the library currently holds from it. */
  readonly noteCount: number;
}

export interface NotesFolderChange extends NotesFolderStatus {
  /** False when the dialog was cancelled, or the chosen folder was unusable. */
  readonly changed: boolean;
  /** Documents dropped because they came from a folder no longer in use. */
  readonly purged: number;
  readonly filesSeen: number;
  readonly documentsCreated: number;
  readonly documentsUpdated: number;
}

/** The folder remembered from a previous run, or null when the choice has not been made. */
export function storedNotesFolder(db: WikiReaderDatabase): string | null {
  const parsed = StoredNotesFolderSchema.safeParse(db.settings.get(NOTES_FOLDER_SETTING));
  return parsed.success ? parsed.data.path : null;
}

export interface NotesFolderOptions {
  readonly db: WikiReaderDatabase;
  readonly importer: MarkdownCorpusImporter;
  readonly roots: SwappableRoots;
  readonly chooseDirectory?: DirectoryChooser | undefined;
  readonly logger?: Logger | undefined;
}

export class NotesFolder {
  readonly #db: WikiReaderDatabase;
  readonly #importer: MarkdownCorpusImporter;
  readonly #roots: SwappableRoots;
  readonly #chooseDirectory: DirectoryChooser | undefined;
  readonly #logger: Logger | undefined;

  constructor(options: NotesFolderOptions) {
    this.#db = options.db;
    this.#importer = options.importer;
    this.#roots = options.roots;
    this.#chooseDirectory = options.chooseDirectory;
    this.#logger = options.logger?.child('notes-folder');
  }

  /** The absolute path. Main-process use only; nothing returns this over IPC. */
  get path(): string {
    return this.#importer.root;
  }

  status(): NotesFolderStatus {
    return {
      folderName: displayName(this.path),
      chosenInApp: storedNotesFolder(this.#db) !== null,
      noteCount: this.#db.documents.list({ source: 'corpus', limit: 1 }).total,
    };
  }

  /**
   * Open the directory dialog and adopt what comes back.
   *
   * A cancelled dialog is not a failure and changes nothing, which is why the result carries
   * `changed` rather than throwing.
   */
  async choose(): Promise<NotesFolderChange> {
    if (this.#chooseDirectory === undefined) {
      this.#logger?.warn('no directory chooser is wired up');
      return this.#unchanged();
    }
    const picked = await this.#chooseDirectory();
    if (picked === null) return this.#unchanged();
    return this.use(picked);
  }

  /**
   * Adopt `path` as the notes folder.
   *
   * Rejects anything that is not an existing absolute directory. The only callers are the
   * dialog and the stored setting, so this is a guard against a hand-edited settings row
   * rather than against the renderer, which cannot reach it.
   */
  async use(path: string): Promise<NotesFolderChange> {
    if (!isAbsolute(path) || !isDirectory(path)) {
      this.#logger?.warn('refusing a notes folder that is not an existing directory');
      return this.#unchanged();
    }

    this.#db.settings.set(NOTES_FOLDER_SETTING, { path });
    this.#roots.swap(path);
    this.#importer.setRoot(path);

    const { purged } = this.#importer.purgeOutsideRoot();
    const summary = await this.#importer.import();

    this.#logger?.info('notes folder changed', {
      purged,
      filesSeen: summary.filesSeen,
      created: summary.documentsCreated,
    });

    return {
      ...this.status(),
      changed: true,
      purged,
      filesSeen: summary.filesSeen,
      documentsCreated: summary.documentsCreated,
      documentsUpdated: summary.documentsUpdated,
    };
  }

  /**
   * Drop notes left behind by a folder that is no longer in use.
   *
   * Run at startup as well as on a change: the folder can also move because the machine's
   * configuration changed under the app, and the library should not show rows it cannot open.
   */
  purgeStrays(): number {
    return this.#importer.purgeOutsideRoot().purged;
  }

  #unchanged(): NotesFolderChange {
    return {
      ...this.status(),
      changed: false,
      purged: 0,
      filesSeen: 0,
      documentsCreated: 0,
      documentsUpdated: 0,
    };
  }
}

/**
 * What the interface calls the folder: its own name, not the road to it.
 *
 * A full path in the renderer would be both a leak of the disk's layout and a string the
 * renderer could send back, which is the shape `rrfile://` exists to prevent.
 */
export function displayName(path: string): string {
  const name = basename(path);
  // Only a filesystem root has no name of its own, and nobody makes their wiki out of one.
  return name === '' ? '/' : name;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
