/**
 * The main-process service container.
 *
 * Everything the IPC handlers need, assembled in one place and free of Electron imports so
 * that the entire backend can be constructed inside a vitest process against a temporary
 * database. That is what makes the persistence criteria (M08, M09, M10, M12, M13, M14)
 * testable as real integration rather than as mocks.
 */
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { openDatabase, type WikiReaderDatabase } from '@wr/database';
import { SearchService, SearchIndexer } from '@wr/search';
import {
  ZoteroImporter,
  ZoteroLocalClient,
  defaultZoteroDataDir,
  type FetchLike,
} from '@wr/zotero-adapter';
import {
  AgentRunIdSchema,
  DocumentIdSchema,
  type IpcTopic,
  type IpcTopicPayload,
} from '@wr/shared-types';
import { createLogger, silentLogger, type Logger } from './logger.js';
import { SwappableRoots, withoutFilesystemPaths, type AllowedRoots } from './paths.js';
import { ExtractionPipeline, type PdfExtractor } from './pipeline.js';
import { MarkdownCorpusImporter } from './corpus.js';
import { NotesFolder, storedNotesFolder, type DirectoryChooser } from './notes-folder.js';
import { LocalFileLibrary, type FileChooser } from './local-files.js';
import { CardArtLibrary, type CardArtFetch } from './card-art.js';
import { AgentWorkspace } from './agents/workspace.js';
import { WikiView } from './agents/wiki-view.js';
import { LibrarianRunner, type AgentSpawn } from './agents/runner.js';
import { ProposalReader } from './agents/proposals.js';
import { LibrarianService } from './agents/librarian.js';
import { LibrarianScheduler } from './agents/schedule.js';
import { readAgentSettings } from './agents/settings.js';
import type { AgentEvent } from './agents/stream.js';

/**
 * The librarian, constructed but inert.
 *
 * Building these objects is free of consequence — no directory is created, no process is
 * spawned, no timer is armed — which is what lets the container be the same whether or not
 * agents are enabled. `A03` is then a statement about *behaviour* rather than about which
 * branch of an `if` ran at startup: with agents off, `scheduler.start()` is never called, the
 * view is never materialised, and the only agent code that executes is the code that answers
 * "are you off?".
 */
export interface AgentServices {
  /** The one directory the librarian may write in. Its notes land here on accept. */
  readonly workspace: AgentWorkspace;
  /** The wiki as crawlable markdown. Written only for the duration of a pass. */
  readonly view: WikiView;
  readonly runner: LibrarianRunner;
  readonly reader: ProposalReader;
  readonly librarian: LibrarianService;
  readonly scheduler: LibrarianScheduler;
  /** The command a run would spawn, so the disclosure can name it rather than imply it. */
  readonly executable: string;
  /**
   * The roots a progress line is reduced against before it reaches the renderer.
   *
   * Named once here rather than rebuilt at each publisher, because a publisher that forgets
   * them does not fail — it silently emits absolute paths, which is the one thing the
   * renderer must never receive.
   */
  readonly progressRoots: readonly string[];
  /**
   * Arm the schedule if — and only if — agents are enabled. Returns whether it was armed.
   *
   * Startup asks this rather than deciding for itself, so the one place that knows what the
   * switch means is the one place that reads it. With agents off no timer exists at all,
   * which is a stronger statement than a timer that keeps deciding not to run.
   */
  readonly startIfEnabled: () => boolean;
}

export interface AppServices {
  readonly db: WikiReaderDatabase;
  readonly zotero: ZoteroLocalClient;
  readonly importer: ZoteroImporter;
  readonly search: SearchService;
  readonly indexer: SearchIndexer;
  readonly pipeline: ExtractionPipeline;
  /** Ingests the markdown corpus. Its root is configured here, never sent by the renderer. */
  readonly corpus: MarkdownCorpusImporter;
  /** Which folder the notes come from, and the machinery for changing it. */
  readonly notesFolder: NotesFolder;
  /** Files added straight from disk — dropped on a board, or picked in the dialog. */
  readonly localFiles: LocalFileLibrary;
  /** Art fetched for graph nodes. Off by default; the only other thing that can leave here. */
  readonly cardArt: CardArtLibrary;
  readonly corpusRoot: string;
  /** The librarian and everything it needs. Built always, started only when enabled. */
  readonly agents: AgentServices;
  readonly logger: Logger;
  readonly allowed: AllowedRoots;
  /** Push an event to every renderer. A no-op when no window exists yet. */
  readonly publish: <K extends IpcTopic>(topic: K, payload: IpcTopicPayload<K>) => void;
  readonly close: () => void;
}

export interface CreateServicesOptions {
  /** Absolute path to the SQLite file, or ':memory:'. */
  readonly databasePath: string;
  /** Path to the better-sqlite3 build matching the host ABI. */
  readonly nativeBinding?: string | undefined;
  readonly zoteroDataDir?: string | undefined;
  /** Root of the markdown corpus. Defaults to `WR_MARKDOWN_ROOT`, then `<userData>/corpus`. */
  readonly markdownRoot?: string | undefined;
  readonly zoteroEndpoint?: string | undefined;
  /**
   * Injectable so an import can be driven over the recorded fixtures, the way `extractPdf` is
   * injectable so pipeline tests need not parse a real PDF. Without it, the only way to reach
   * `zotero:import` is a running Zotero, so the channel itself went untested.
   */
  readonly zoteroFetch?: FetchLike | undefined;
  /**
   * How card art is requested (criterion G05). Injected for the same reason `zoteroFetch` is:
   * a test that reached Scryfall would depend on the network this application exists to avoid,
   * and would prove nothing about the invariant — how often the app leaves this machine.
   */
  readonly cardArtFetch?: CardArtFetch | undefined;
  /** Where fetched art is kept. Defaults to a `card-art` directory beside the database. */
  readonly cardArtRoot?: string | undefined;
  readonly logger?: Logger | undefined;
  readonly publish?: (<K extends IpcTopic>(topic: K, payload: IpcTopicPayload<K>) => void) | undefined;
  /** Injectable so pipeline tests need not parse a real PDF. */
  readonly extractPdf?: PdfExtractor | undefined;
  /** Extra directories the file protocol and extractor may read from. Tests use this. */
  readonly extraRoots?: readonly string[] | undefined;
  /**
   * Opens the native directory dialog. Injected because Electron's `dialog` cannot be reached
   * from a vitest process — and because the folder-change sequence below it (remember, swap,
   * purge, re-import) is the part worth testing, not the dialog.
   */
  readonly chooseDirectory?: DirectoryChooser | undefined;
  /**
   * Opens the native file dialog behind "add a file from disk" (criterion B02). Injected for
   * the same reason as `chooseDirectory`: Electron's `dialog` cannot be reached from a vitest
   * process, and what the choice then does is the part that has to be tested.
   */
  readonly chooseFiles?: FileChooser | undefined;
  /**
   * Where the librarian's workspace and the materialised wiki live. Defaults to an `agent`
   * directory beside the database, so a test workspace carries its own and nothing leaks
   * between them.
   */
  readonly agentRoot?: string | undefined;
  /** The `claude` executable. Tests point it at a stub that replays a recorded transcript. */
  readonly agentExecutable?: string | undefined;
  readonly agentSpawn?: AgentSpawn | undefined;
  /** How often the schedule is reconsidered. Not how often a pass runs. */
  readonly agentTickMs?: number | undefined;
}

export function createServices(options: CreateServicesOptions): AppServices {
  const logger = options.logger ?? createLogger();
  const zoteroDataDir = options.zoteroDataDir ?? defaultZoteroDataDir();

  const { db, migration } = openDatabase({
    file: options.databasePath,
    nativeBinding: options.nativeBinding,
  });
  logger.info('database ready', {
    path: options.databasePath,
    version: migration.version,
    applied: migration.applied.length,
  });

  // A folder chosen in the app outranks configuration: the choice was made here, by the
  // person using it, and an environment variable set once at install time should not quietly
  // take it back on the next launch.
  const corpusRoot = storedNotesFolder(db) ?? options.markdownRoot ?? defaultMarkdownRoot();
  const agentRoot = options.agentRoot ?? defaultAgentRoot(options.databasePath);
  const workspaceRoot = join(agentRoot, 'librarian');
  const cardArtRoot = options.cardArtRoot ?? defaultCardArtRoot(options.databasePath);
  // Made now, before the allow-list is built, and not when the first picture arrives. Roots are
  // resolved through symlinks at construction and a directory that does not exist yet stays in
  // the list *lexically* — so on macOS, where the temporary directory is `/var` -> `/private/var`,
  // a card-art root created later would resolve to a path outside the root that names it and
  // `rrfile://` would refuse every picture in it.
  mkdirSync(cardArtRoot, { recursive: true });
  // The librarian's workspace joins the *fixed* roots rather than the swappable slot: an
  // accepted note is an ordinary document, opened through `rrfile://` like any other, and the
  // protocol refuses anything outside the list. Fixed because unlike the notes folder it is
  // not a choice — it is where this installation keeps the agent's work. The card-art cache is
  // fixed for the same reason.
  const allowed = new SwappableRoots(
    [zoteroDataDir, workspaceRoot, cardArtRoot, ...(options.extraRoots ?? [])],
    corpusRoot,
  );
  const publish = options.publish ?? ((): void => undefined);

  const pipeline = new ExtractionPipeline(db, {
    logger,
    allowed,
    ...(options.extractPdf === undefined ? {} : { extractPdf: options.extractPdf }),
    onProgress: (progress) => {
      publish('indexing:progress', {
        documentId: DocumentIdSchema.parse(progress.documentId),
        stage: progress.stage,
        processed: progress.processed,
        total: progress.total,
        ...(progress.message === undefined ? {} : { message: progress.message }),
      });
    },
  });

  const zotero = new ZoteroLocalClient({
    ...(options.zoteroEndpoint === undefined ? {} : { endpoint: options.zoteroEndpoint }),
    ...(options.zoteroFetch === undefined ? {} : { fetch: options.zoteroFetch }),
  });

  const importer = new ZoteroImporter(zotero, db, {
    dataDir: zoteroDataDir,
    logger: {
      info: (event, fields) => logger.child('zotero').info(event, fields),
      warn: (event, fields) => logger.child('zotero').warn(event, fields),
    },
    onProgress: (progress) => {
      publish('zotero:importProgress', {
        phase: progress.phase,
        processed: progress.processed,
        total: progress.total,
      });
    },
  });

  const corpus = new MarkdownCorpusImporter(db, { root: corpusRoot, allowed, logger });
  const agents = createAgentServices({ db, logger, publish, agentRoot, options });

  const localFiles = new LocalFileLibrary({
    db,
    roots: allowed,
    logger,
    enqueueExtraction: (documentId) => {
      pipeline.enqueue(documentId);
    },
    ...(options.chooseFiles === undefined ? {} : { chooseFiles: options.chooseFiles }),
  });
  // Before anything can ask for bytes: a file added yesterday is a library row whose path is
  // outside every root, so without the remembered admissions it would open as `403 Forbidden`.
  localFiles.restore();

  // Built always and armed by nothing: `illustrate` reads the switch itself, so constructing
  // this can never be what makes a request possible.
  const cardArt = new CardArtLibrary({
    db,
    root: cardArtRoot,
    logger,
    ...(options.cardArtFetch === undefined ? {} : { fetch: options.cardArtFetch }),
  });

  return {
    db,
    zotero,
    importer,
    search: new SearchService(db),
    indexer: new SearchIndexer(db, {
      info: (message, fields) => logger.child('index').info(message, fields),
      warn: (message, fields) => logger.child('index').warn(message, fields),
    }),
    pipeline,
    corpus,
    notesFolder: new NotesFolder({
      db,
      importer: corpus,
      roots: allowed,
      logger,
      ...(options.chooseDirectory === undefined ? {} : { chooseDirectory: options.chooseDirectory }),
    }),
    localFiles,
    cardArt,
    // A getter, because the notes folder can be chosen while the app runs and a snapshot
    // taken at construction would go on naming the folder that was left behind.
    get corpusRoot(): string {
      return corpus.root;
    },
    agents,
    logger,
    allowed,
    publish,
    close: () => {
      // The timer first, then the children: a pass started during shutdown would outlive the
      // window it belongs to, and a `claude` left running after the app quits is a process
      // nobody can see to stop.
      agents.scheduler.stop();
      agents.runner.cancelAll();
      db.close();
      logger.info('database closed');
    },
  };
}

/**
 * Assemble the librarian.
 *
 * Nothing here touches the disk or the network. The workspace resolves its root lazily, the
 * view is written only by `materialise`, the runner spawns only when asked, and the scheduler
 * arms no timer until `start()`. That is the whole of what makes "agents are off" a true
 * statement about a *running* app rather than about its configuration file.
 */
function createAgentServices(input: {
  readonly db: WikiReaderDatabase;
  readonly logger: Logger;
  readonly publish: <K extends IpcTopic>(topic: K, payload: IpcTopicPayload<K>) => void;
  readonly agentRoot: string;
  readonly options: CreateServicesOptions;
}): AgentServices {
  const { db, logger, publish, agentRoot, options } = input;

  const workspace = new AgentWorkspace({ root: join(agentRoot, 'librarian'), logger });
  const view = new WikiView({ db, root: join(agentRoot, 'wiki'), logger });
  const runner = new LibrarianRunner({
    workspace,
    logger,
    ...(options.agentExecutable === undefined ? {} : { executable: options.agentExecutable }),
    ...(options.agentSpawn === undefined ? {} : { spawn: options.agentSpawn }),
  });
  const reader = new ProposalReader({ workspace, db, logger });
  const librarian = new LibrarianService({ db, workspace, view, runner, reader, logger });
  // The two places a run's paths can point: the wiki it reads and the workspace it writes in.
  const progressRoots = [view.root, workspace.root];

  const scheduler = new LibrarianScheduler({
    logger,
    // Read fresh at every tick rather than captured: the switch can be thrown, and a batch of
    // imports can arrive, long after this object was built.
    observe: () => {
      const settings = readAgentSettings(db);
      const lastRun = db.agentRuns.latest();
      return {
        now: Date.now(),
        enabled: settings.enabled,
        // `decidePass` refuses a pass while one is running; the runner alone would say "not
        // running" for the whole of the previous pass's materialise.
        running: librarian.busy || runner.busy,
        lastRun,
        importedSince: lastRun === null ? 0 : db.documents.countCreatedSince(lastRun.startedAt),
      };
    },
    startPass: (trigger) =>
      librarian.pass({ trigger, capabilities: readAgentSettings(db).capabilities }, (event, runId) =>
        publish('agent:progress', agentProgress(runId, event, progressRoots)),
      ),
    ...(options.agentTickMs === undefined ? {} : { tickMs: options.agentTickMs }),
  });

  return {
    workspace,
    view,
    runner,
    reader,
    librarian,
    scheduler,
    executable: options.agentExecutable ?? 'claude',
    progressRoots,
    startIfEnabled: () => {
      if (!readAgentSettings(db).enabled) return false;
      scheduler.start();
      return true;
    },
  };
}

/**
 * A stream event as one line an interface can show.
 *
 * The full transcript is not what a person watching a pass wants — they want to know it is
 * still moving and roughly where it is. Everything richer than that belongs in the log.
 *
 * `roots` are the directories the run was given. They are not a filter on *what* is reported
 * but on *how*: this is the boundary the transcript's absolute paths must not cross, so both
 * the free-text fields go through `withoutFilesystemPaths` on the way out. The log keeps the
 * unreduced form; the renderer never sees it.
 */
export function agentProgress(
  runId: string,
  event: AgentEvent,
  roots: readonly string[] = [],
): IpcTopicPayload<'agent:progress'> {
  switch (event.kind) {
    case 'started':
      return { runId: AgentRunIdSchema.parse(runId), phase: 'started', detail: `Reading the wiki with ${event.model}` };
    case 'tool':
      return {
        runId: AgentRunIdSchema.parse(runId),
        phase: 'working',
        detail:
          event.target === null
            ? event.tool
            : `${event.tool} ${withoutFilesystemPaths(event.target, roots)}`,
      };
    case 'message':
      return {
        runId: AgentRunIdSchema.parse(runId),
        phase: 'working',
        detail: withoutFilesystemPaths(event.text.trim().split('\n')[0]?.slice(0, 200) ?? '', roots),
      };
    case 'finished':
      return {
        runId: AgentRunIdSchema.parse(runId),
        phase: 'finished',
        detail: event.ok ? `Finished after ${String(event.turns)} turns` : 'The pass did not finish',
      };
    case 'thinking':
      return { runId: AgentRunIdSchema.parse(runId), phase: 'working', detail: 'Thinking' };
    case 'tool-result':
      return {
        runId: AgentRunIdSchema.parse(runId),
        phase: 'working',
        detail: event.isError ? 'A tool call failed' : 'Read',
      };
  }
}

/**
 * Where the agent's workspace lives when nothing says otherwise: beside the database.
 *
 * Beside it rather than in a fixed location, because a second library is a second wiki and
 * the librarian's notes about one have no business appearing in the other.
 */
/** Where fetched card art is kept: beside the database, like the librarian's workspace. */
export function defaultCardArtRoot(databasePath: string): string {
  if (isAbsolute(databasePath)) return join(dirname(databasePath), 'card-art');
  return join(tmpdir(), 'wiki-reader', 'card-art');
}

export function defaultAgentRoot(databasePath: string): string {
  if (isAbsolute(databasePath)) return join(dirname(databasePath), 'agent');
  // `:memory:` and other non-paths: there is no library directory to sit beside, so the
  // workspace goes somewhere writable and disposable rather than into the user's home.
  return join(tmpdir(), 'wiki-reader', 'agent');
}

/**
 * Where the wiki lives when nothing says otherwise.
 *
 * `WR_MARKDOWN_ROOT` is read from the environment of the *main* process, so the corpus
 * location is a property of the installation rather than something a renderer can name.
 */
export function defaultMarkdownRoot(): string {
  const configured = process.env['WR_MARKDOWN_ROOT'];
  if (configured !== undefined && configured.length > 0) return configured;
  return join(homedir(), 'wiki-reader', 'corpus');
}

/** Convenience for tests: a service container that logs nowhere. */
export function createTestServices(
  options: Omit<CreateServicesOptions, 'logger'> & { logger?: Logger },
): AppServices {
  return createServices({ ...options, logger: options.logger ?? silentLogger });
}
