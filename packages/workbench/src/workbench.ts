import { NavigationHistory } from '@wr/document-model';
import type {
  DocumentId,
  LinkableEntityType,
  Link,
  NavigationLocation,
  ResolvedLink,
} from '@wr/shared-types';
import {
  CommandRegistry,
  type CommandArgs,
  type CommandDefinition,
  type CommandSearchResult,
} from './commands.js';
import { ContextKeyService, type ContextSnapshot } from './context.js';
import {
  internalLinkFor,
  linkTypeLabel,
  linkTypesFor,
  otherEndpoint,
  type EntityRef,
} from './entity-links.js';
import {
  KeybindingRegistry,
  parseKeybindingsFile,
  type KeyboardEventLike,
  type KeybindingRule,
  type Platform,
} from './keybindings.js';
import type { PanelDescriptor } from './layout.js';
import { hasParent, resolveParent } from './parent.js';
import {
  resolveOpen,
  type OpenMode,
  type OpenPlan,
  type WorkspaceSnapshot,
} from './panel-targets.js';

/**
 * The workbench: one command registry, one keybinding registry, one context key store,
 * and the navigation history they all share.
 *
 * Everything the user can do to the workspace goes through `commands.execute`. A panel
 * never reaches into another panel, so adding a way to trigger an action — a toolbar
 * button, a context menu, a keystroke, the palette — never means reimplementing the action.
 *
 * The workbench owns no rendering. It talks to the renderer through `WorkbenchHost`, which
 * the Dockview shell implements. That boundary is what keeps this package testable in
 * plain Node and free of any main-process import.
 *
 * Criterion L09: centralized command and keybinding registry.
 */

export const COMMAND_IDS = {
  openDocument: 'wr.openDocument',
  openDocumentAtLocation: 'wr.openDocumentAtLocation',
  openAnnotation: 'wr.openAnnotation',
  openNote: 'wr.openNote',
  openSearch: 'wr.openSearch',
  openToSide: 'wr.openToSide',
  splitCurrentPanel: 'wr.splitCurrentPanel',
  closeTab: 'wr.closeTab',
  closeGroup: 'wr.closeGroup',
  toggleLibrarySidebar: 'wr.toggleLibrarySidebar',
  toggleQuestionsSidebar: 'wr.toggleQuestionsSidebar',
  openJournal: 'wr.openJournal',
  toggleLibrarianSidebar: 'wr.toggleLibrarianSidebar',
  toggleAnnotationSidebar: 'wr.toggleAnnotationSidebar',
  goToTarget: 'wr.goToTarget',
  goToDefinition: 'wr.goToDefinition',
  peekDefinition: 'wr.peekDefinition',
  goToParent: 'wr.goToParent',
  goToSource: 'wr.goToSource',
  findAllReferences: 'wr.findAllReferences',
  findAllLinksOfType: 'wr.findAllLinksOfType',
  findIncomingLinks: 'wr.findIncomingLinks',
  findOutgoingLinks: 'wr.findOutgoingLinks',
  openBacklinks: 'wr.openBacklinks',
  openLinkGraph: 'wr.openLinkGraph',
  openWiki: 'wr.openWiki',
  openFocusView: 'wr.openFocusView',
  openLedger: 'wr.openLedger',
  openNotebook: 'wr.openNotebook',
  openNotebookDirectory: 'wr.openNotebookDirectory',
  goBack: 'wr.goBack',
  goForward: 'wr.goForward',
  goToNextReference: 'wr.goToNextReference',
  goToPreviousReference: 'wr.goToPreviousReference',
  copyInternalLink: 'wr.copyInternalLink',
  revealInLibrary: 'wr.revealInLibrary',
  showCommands: 'wr.showCommands',
  linkToDocument: 'wr.linkToDocument',
  createDocumentLink: 'wr.createDocumentLink',
  newNoteFromHere: 'wr.newNoteFromHere',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

export interface ReferenceQuery {
  readonly entity: EntityRef;
  readonly direction: 'incoming' | 'outgoing' | 'both';
  readonly linkType?: string;
}

/**
 * One typed edge, as the reader's link gesture asks for it.
 *
 * Both ends are entity references rather than document ids (`H02`). A highlight is a first
 * class thing in this app — it has its own id, its own node in the graph and its own links —
 * so "the sentence I marked in this paper bears on that one" has to be sayable without being
 * collapsed into a claim about the whole paper it happens to live in.
 */
export interface EntityLinkRequest {
  readonly source: EntityRef;
  readonly target: EntityRef;
  /** Chosen by the researcher. Never defaulted — see `linkTypesFor`. */
  readonly type: string;
}

/** What the renderer must provide. Implemented by the Dockview shell in @wr/desktop. */
export interface WorkbenchHost {
  /** Current workspace shape, for deciding where a panel should land. */
  getWorkspace(): WorkspaceSnapshot;
  /** Carry out an open plan against Dockview. */
  applyPlan(plan: OpenPlan): void | Promise<void>;
  /** The entity the user is on: selected annotation, focused note, open document. */
  getActiveEntity(): EntityRef | null;
  /** The internal link under the cursor, when there is one. */
  getLinkUnderCursor(): EntityRef | null;
  /** Which panel shows an entity. Returns `null` for entities with no panel of their own. */
  describeEntity(entity: EntityRef): PanelDescriptor | null | Promise<PanelDescriptor | null>;
  /** Every typed edge touching an entity. Implemented over IPC. */
  getLinks(entity: EntityRef): readonly Link[] | Promise<readonly Link[]>;
  /** Edges resolved with display information for the references panel. */
  resolveLinks(query: ReferenceQuery): readonly ResolvedLink[] | Promise<readonly ResolvedLink[]>;
  /**
   * Close one open tab. `null` means the focused one.
   *
   * Closing is a workbench command like any other because the alternative is what shipped:
   * no command, no binding, and `Ctrl/Cmd+W` reaching Chromium, which closes the *window*.
   */
  closePanel(panelId: string | null): void | Promise<void>;
  /** Close every tab in one group. `null` means the group the focused tab is in. */
  closeGroup(groupId: string | null): void | Promise<void>;
  /** Show a result set in the reusable references panel, never a modal. */
  showReferences(
    query: ReferenceQuery,
    results: readonly ResolvedLink[],
  ): void | Promise<void>;
  /** Step within the active references result set. */
  stepReference(delta: 1 | -1): void | Promise<void>;
  /** Inline peek preview. */
  showPeek(entity: EntityRef): void | Promise<void>;
  revealInLibrary(entity: EntityRef): void | Promise<void>;
  toggleSidebar(
    which: 'library' | 'questions' | 'librarian' | 'annotations' | 'bottomPanel',
  ): void | Promise<void>;
  copyToClipboard(text: string): void | Promise<void>;
  /**
   * Show or hide the list of every command, each with the key that runs it.
   *
   * The registry has always known which chord runs what; nothing rendered it, so the only way
   * to find an action was to already know its key (criterion `K03`).
   */
  showCommands(open: boolean): void | Promise<void>;
  /** Ask the researcher what to link this to, and what to call the relationship. */
  promptEntityLink(source: EntityRef): void | Promise<void>;
  /** Write one typed edge between two entities. `null` when it could not be written. */
  createEntityLink(request: EntityLinkRequest): Promise<Link | null>;
  /**
   * Make a note *from* an entity, linked to it in the same action, and return its id.
   *
   * One action rather than create-then-link: a note that claims to be about a highlight but
   * carries no edge is unreachable from it, which is the failure `K02` is about.
   */
  createNoteFrom(entity: EntityRef): Promise<string | null>;
  /** Where the user is now, recorded into history before navigating away. */
  currentNavigationLocation(): NavigationLocation | null;
}

export class WorkbenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchError';
  }
}

function entityFromArgs(args: CommandArgs): EntityRef | null {
  const entityId = args['entityId'];
  const entityType = args['entityType'];
  if (typeof entityId !== 'string' || typeof entityType !== 'string') return null;
  const ref: Record<string, unknown> = { entityId, entityType };
  if (typeof args['documentId'] === 'string') ref['documentId'] = args['documentId'];
  if (args['location'] !== undefined && args['location'] !== null) ref['location'] = args['location'];
  return ref as unknown as EntityRef;
}

function modeFromArgs(args: CommandArgs, fallback: OpenMode): OpenMode {
  const mode = args['mode'];
  return mode === 'current' || mode === 'side' || mode === 'new-tab' ? mode : fallback;
}

// ---------------------------------------------------------------------------
// Default keybindings
// ---------------------------------------------------------------------------

/**
 * Fixed defaults for milestone 1. Users will override them through a JSON file; the
 * registry already supports that (`parseKeybindingsFile`), only the settings UI is
 * deferred.
 *
 * `!textInputFocus` guards every binding that would otherwise steal a key from the note
 * editor, which docs/SPEC.md calls out explicitly for Go to Parent.
 */
export const DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [
  { commandId: COMMAND_IDS.goToTarget, key: 'f12', when: 'linkUnderCursor' },
  { commandId: COMMAND_IDS.peekDefinition, key: 'alt+f12', when: 'linkUnderCursor' },
  { commandId: COMMAND_IDS.findAllReferences, key: 'shift+f12' },
  {
    commandId: COMMAND_IDS.goToParent,
    key: 'ctrl+up',
    mac: 'cmd+up',
    when: 'canGoToParent && !textInputFocus',
  },
  { commandId: COMMAND_IDS.goBack, key: 'alt+left', mac: 'ctrl+minus', when: 'canGoBack' },
  {
    commandId: COMMAND_IDS.goForward,
    key: 'alt+right',
    mac: 'ctrl+shift+minus',
    when: 'canGoForward',
  },
  { commandId: COMMAND_IDS.goToNextReference, key: 'f4' },
  { commandId: COMMAND_IDS.goToPreviousReference, key: 'shift+f4' },
  { commandId: COMMAND_IDS.openSearch, key: 'ctrl+shift+f', mac: 'cmd+shift+f' },
  { commandId: COMMAND_IDS.toggleLibrarySidebar, key: 'ctrl+b', mac: 'cmd+b' },
  {
    commandId: COMMAND_IDS.openToSide,
    key: 'ctrl+enter',
    mac: 'cmd+enter',
    when: '!textInputFocus',
  },
  { commandId: COMMAND_IDS.copyInternalLink, key: 'ctrl+alt+c', mac: 'cmd+alt+c' },
  // Deliberately unconditional. A `when` clause that stopped matching once the last tab was
  // closed would hand the keystroke back to Chromium, and Chromium closes the window — which
  // is the failure this binding exists to prevent. With nothing open the command runs and
  // does nothing, and the window stays.
  { commandId: COMMAND_IDS.closeTab, key: 'ctrl+w', mac: 'cmd+w' },
  { commandId: COMMAND_IDS.closeGroup, key: 'ctrl+shift+w', mac: 'cmd+shift+w' },
  // Deliberately unconditional, and deliberately the one binding with no `!textInputFocus`
  // guard: the command list is how someone who is lost finds their way out, and being inside
  // a note is exactly when that happens.
  { commandId: COMMAND_IDS.showCommands, key: 'ctrl+shift+p', mac: 'cmd+shift+p' },
  {
    commandId: COMMAND_IDS.linkToDocument,
    key: 'ctrl+alt+l',
    mac: 'cmd+alt+l',
    when: '!textInputFocus',
  },
  {
    commandId: COMMAND_IDS.newNoteFromHere,
    key: 'ctrl+alt+n',
    mac: 'cmd+alt+n',
    when: '!textInputFocus',
  },
];

// ---------------------------------------------------------------------------
// Workbench
// ---------------------------------------------------------------------------

export interface WorkbenchOptions {
  readonly platform?: Platform;
  readonly historyLimit?: number;
  /** Skip the built-in command table; used by tests that register their own. */
  readonly registerDefaults?: boolean;
}

export class Workbench {
  readonly commands = new CommandRegistry();
  readonly contextKeys = new ContextKeyService();
  readonly keybindings: KeybindingRegistry;
  readonly history: NavigationHistory;
  readonly #host: WorkbenchHost;

  constructor(host: WorkbenchHost, options: WorkbenchOptions = {}) {
    this.#host = host;
    this.keybindings = new KeybindingRegistry(options.platform ?? 'mac');
    this.history =
      options.historyLimit === undefined
        ? new NavigationHistory()
        : new NavigationHistory(options.historyLimit);

    if (options.registerDefaults !== false) {
      this.commands.registerAll(this.builtinCommands());
      this.keybindings.registerAll(DEFAULT_KEYBINDINGS);
    }
    this.#syncHistoryContext();
  }

  /** Snapshot of the context keys, as passed to every command and keybinding lookup. */
  context(): ContextSnapshot {
    return this.contextKeys.snapshot();
  }

  /**
   * Handle a key event. Returns the command that ran, or `null` when nothing matched and
   * the event should reach the DOM unchanged.
   */
  async handleKeyDown(event: KeyboardEventLike): Promise<string | null> {
    const context = this.context();
    const match = this.keybindings.resolveEvent(event, context, this.commands);
    if (match === null) return null;
    await this.commands.execute(match.commandId, match.args ?? {}, context);
    return match.commandId;
  }

  /** Command palette query. */
  searchCommands(query: string): CommandSearchResult[] {
    return this.commands.search(query, this.context());
  }

  /** Load user overrides on top of the defaults. Returns the messages for rejected rules. */
  loadUserKeybindings(input: unknown): readonly string[] {
    const { rules, errors } = parseKeybindingsFile(input);
    this.keybindings.registerAll(rules);
    return errors;
  }

  /** Record where we are, then navigate. Every command that moves the user calls this. */
  async navigate(entity: EntityRef, mode: OpenMode = 'current'): Promise<OpenPlan | null> {
    const from = this.#host.currentNavigationLocation();
    if (from !== null) this.history.push(from);

    const plan = await this.#planFor(entity, mode);
    if (plan === null) return null;

    await this.#host.applyPlan(plan);
    this.#syncHistoryContext();
    return plan;
  }

  async #planFor(entity: EntityRef, mode: OpenMode): Promise<OpenPlan | null> {
    const descriptor = await this.#host.describeEntity(entity);
    if (descriptor === null) return null;
    return resolveOpen(
      {
        descriptor,
        mode,
        location: entity.location ?? null,
      },
      this.#host.getWorkspace(),
    );
  }

  #syncHistoryContext(): void {
    this.contextKeys.setMany({
      canGoBack: this.history.canGoBack,
      canGoForward: this.history.canGoForward,
    });
  }

  async #restore(location: NavigationLocation | null): Promise<boolean> {
    if (location === null) return false;
    const entity: EntityRef = {
      entityId: location.entityId,
      entityType: location.entityType,
      ...(location.documentId === undefined ? {} : { documentId: location.documentId }),
      ...(location.location === undefined ? {} : { location: location.location }),
    };
    const plan = await this.#planFor(entity, 'current');
    if (plan !== null) await this.#host.applyPlan(plan);
    this.#syncHistoryContext();
    return plan !== null;
  }

  /** The entity a navigation command should act on: explicit args, cursor, then selection. */
  #subject(args: CommandArgs): EntityRef {
    return this.#subjectOr(args, 'no entity to act on');
  }

  /**
   * The same resolution, with a message a person can act on when it comes up empty.
   *
   * `no entity to act on` is accurate and tells the reader nothing about what to do instead.
   * A command whose failure a user can actually hit from a button should name the thing that
   * would make it work; the message reaches the status bar unchanged, so it is written as a
   * sentence rather than a code.
   */
  #subjectOr(args: CommandArgs, whenMissing: string): EntityRef {
    const explicit = entityFromArgs(args);
    if (explicit !== null) return explicit;
    const underCursor = this.#host.getLinkUnderCursor();
    if (underCursor !== null) return underCursor;
    const active = this.#host.getActiveEntity();
    if (active !== null) return active;
    throw new WorkbenchError(whenMissing);
  }

  /**
   * The end a link is made *from*.
   *
   * Deliberately *not* `#subject`: that one prefers the link under the cursor, which is right
   * for "follow this" and wrong for "link what I am reading to something else" — hovering a
   * citation chip while reaching for the menu would silently change which end the link came
   * from.
   *
   * It is also deliberately not collapsed to a document. It used to be: a selected highlight
   * resolved to the paper holding it, which made a highlight the one thing in this app that
   * could be linked *to* and never linked *from* (`H02`). The caller says which it wants by
   * passing `sourceType` — the reader's strip asks for the file it is above, the annotation
   * sidebar asks for the highlight — and with neither given, whatever is active is taken as
   * it is.
   */
  #linkSubject(args: CommandArgs): EntityRef {
    const explicitId = args['sourceId'];
    if (typeof explicitId === 'string' && explicitId !== '') {
      const explicitType = args['sourceType'];
      const entityType: LinkableEntityType =
        typeof explicitType === 'string' && explicitType !== ''
          ? (explicitType as LinkableEntityType)
          : 'document';
      const documentId = args['documentId'];
      return {
        entityId: explicitId,
        entityType,
        ...(typeof documentId === 'string' && documentId !== ''
          ? { documentId: documentId as DocumentId }
          : {}),
      };
    }

    const active = this.#host.getActiveEntity();
    if (active !== null) return active;
    throw new WorkbenchError(
      'Open a document first — a link is made from the one you are reading.',
    );
  }

  async #showReferences(query: ReferenceQuery): Promise<readonly ResolvedLink[]> {
    const results = await this.#host.resolveLinks(query);
    await this.#host.showReferences(query, results);
    return results;
  }

  /** The built-in command table. Every id in docs/SPEC.md's navigation list is present. */
  builtinCommands(): CommandDefinition[] {
    const host = this.#host;

    return [
      {
        id: COMMAND_IDS.openDocument,
        title: 'Open Document',
        category: 'Document',
        keywords: ['show', 'read', 'view pdf'],
        handler: async (args) => this.navigate(this.#subject(args), modeFromArgs(args, 'current')),
      },
      {
        id: COMMAND_IDS.openDocumentAtLocation,
        title: 'Open Document at Location',
        category: 'Document',
        keywords: ['go to page', 'jump'],
        handler: async (args) => this.navigate(this.#subject(args), modeFromArgs(args, 'current')),
      },
      {
        id: COMMAND_IDS.openAnnotation,
        title: 'Open Annotation',
        category: 'Annotations',
        keywords: ['highlight', 'show annotation'],
        handler: async (args) => this.navigate(this.#subject(args), modeFromArgs(args, 'current')),
      },
      {
        id: COMMAND_IDS.openNote,
        title: 'Open Note',
        category: 'Notes',
        handler: async (args) => this.navigate(this.#subject(args), modeFromArgs(args, 'current')),
      },
      {
        id: COMMAND_IDS.openToSide,
        title: 'Open to the Side',
        category: 'Document',
        keywords: ['split', 'beside', 'second pane'],
        handler: async (args) => this.navigate(this.#subject(args), 'side'),
      },
      {
        id: COMMAND_IDS.splitCurrentPanel,
        title: 'Split Editor',
        category: 'View',
        keywords: ['split pane', 'side by side'],
        handler: async (args) => this.navigate(this.#subject(args), 'side'),
      },
      {
        id: COMMAND_IDS.closeTab,
        title: 'Close Tab',
        category: 'View',
        keywords: ['close editor', 'close panel', 'dismiss'],
        // No entity and no navigation: closing acts on a *panel*, and with nothing open it
        // is a no-op rather than an error. Throwing here would surface "no entity to act on"
        // in the status bar every time someone pressed the key on an empty workspace.
        handler: (args) => {
          const panelId = typeof args['panelId'] === 'string' ? args['panelId'] : null;
          return host.closePanel(panelId);
        },
      },
      {
        id: COMMAND_IDS.closeGroup,
        title: 'Close Group',
        category: 'View',
        keywords: ['close split', 'close all in group', 'unsplit'],
        handler: (args) => {
          const groupId = typeof args['groupId'] === 'string' ? args['groupId'] : null;
          return host.closeGroup(groupId);
        },
      },
      {
        id: COMMAND_IDS.openNotebook,
        title: 'Open Notebook',
        category: 'Notebooks',
        keywords: ['page', 'hypotheses', 'notebook', 'field notebook'],
        // Opened *on* a notebook, and only on one: the page is the whole panel, so there is
        // no "open the notebook" with nothing chosen. Called with a `questionId` from the
        // directory or the list, which are the doors the researcher actually uses.
        handler: async (args) => {
          const questionId = args['questionId'];
          if (typeof questionId !== 'string' || questionId === '') {
            throw new Error('Open Notebook needs a notebook — pick one from the directory.');
          }
          const plan = resolveOpen(
            { descriptor: { kind: 'notebook', questionId }, mode: modeFromArgs(args, 'current') },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.openNotebookDirectory,
        title: 'Open Notebooks',
        category: 'Notebooks',
        keywords: ['directory', 'index', 'all notebooks', 'journals', 'shelf'],
        // The front door (`P01`): every notebook, and the way in to each one's page and log.
        handler: async (args) => {
          const plan = resolveOpen(
            { descriptor: { kind: 'notebook-directory' }, mode: modeFromArgs(args, 'current') },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.openSearch,
        title: 'Search Library',
        category: 'Search',
        keywords: ['find text', 'full text search'],
        handler: async (args) => {
          const query = typeof args['query'] === 'string' ? args['query'] : '';
          const plan = resolveOpen(
            { descriptor: { kind: 'search-results', query, filters: null, selectedResultIndex: null }, mode: 'current' },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.toggleLibrarySidebar,
        title: 'Toggle Library Sidebar',
        category: 'View',
        handler: async () => host.toggleSidebar('library'),
      },
      {
        id: COMMAND_IDS.toggleQuestionsSidebar,
        title: 'Toggle Notebooks Sidebar',
        category: 'View',
        keywords: ['queue', 'notebooks', 'what next'],
        handler: async () => host.toggleSidebar('questions'),
      },
      {
        id: COMMAND_IDS.openJournal,
        title: 'Open Journal',
        category: 'Journal',
        keywords: ['diary', 'day entry', 'today', 'log'],
        // A page in the workspace rather than a sidebar toggle (`N09`), opened on the
        // notebook whose log it is (`P02`). One per notebook: the calendar moves that page
        // between days, so opening the same notebook's journal twice reveals the tab that is
        // already there, while another notebook's journal is a different log.
        //
        // The caller supplies the notebook. The workbench has no way to ask which one is
        // meant — that is a question about the library, and this package never talks to it.
        handler: async (args) => {
          const questionId = args['questionId'];
          if (typeof questionId !== 'string' || questionId === '') {
            throw new Error('A journal belongs to a notebook — open one from the directory.');
          }
          const plan = resolveOpen(
            { descriptor: { kind: 'journal', questionId }, mode: modeFromArgs(args, 'current') },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.toggleLibrarianSidebar,
        title: 'Toggle Librarian Sidebar',
        category: 'View',
        keywords: ['agent', 'proposals', 'librarian'],
        handler: async () => host.toggleSidebar('librarian'),
      },
      {
        id: COMMAND_IDS.toggleAnnotationSidebar,
        title: 'Toggle Annotation Sidebar',
        category: 'View',
        handler: async () => host.toggleSidebar('annotations'),
      },
      {
        id: COMMAND_IDS.goToTarget,
        title: 'Go to Target',
        category: 'Navigation',
        keywords: ['follow link', 'f12', 'go to definition'],
        when: 'linkUnderCursor || documentSelected || annotationSelected',
        handler: async (args) => this.navigate(this.#subject(args), modeFromArgs(args, 'current')),
      },
      {
        id: COMMAND_IDS.goToDefinition,
        title: 'Go to Definition',
        category: 'Navigation',
        keywords: ['follow link'],
        when: 'linkUnderCursor',
        handler: async (args) => this.navigate(this.#subject(args), modeFromArgs(args, 'current')),
      },
      {
        id: COMMAND_IDS.peekDefinition,
        title: 'Peek Target',
        category: 'Navigation',
        keywords: ['preview', 'inline'],
        when: 'linkUnderCursor',
        handler: async (args) => host.showPeek(this.#subject(args)),
      },
      {
        id: COMMAND_IDS.goToParent,
        title: 'Go to Parent',
        category: 'Navigation',
        keywords: ['containing document', 'up', 'enclosing'],
        handler: async (args) => {
          const entity = this.#subject(args);
          const links = await host.getLinks(entity);
          const resolved = resolveParent(entity, links);
          if (resolved === null) return null;
          return this.navigate(resolved.parent, modeFromArgs(args, 'current'));
        },
      },
      {
        id: COMMAND_IDS.goToSource,
        title: 'Go to Source',
        category: 'Navigation',
        keywords: ['origin', 'where from'],
        handler: async (args) => {
          const entity = this.#subject(args);
          const links = await host.getLinks(entity);
          const incoming = links.find((link) => link.targetId === entity.entityId);
          if (incoming === undefined) return null;
          return this.navigate(otherEndpoint(incoming, entity.entityId), 'current');
        },
      },
      {
        id: COMMAND_IDS.findAllReferences,
        title: 'Find All References',
        category: 'Links',
        keywords: ['who links here', 'backlinks', 'shift f12'],
        handler: async (args) =>
          this.#showReferences({ entity: this.#subject(args), direction: 'both' }),
      },
      {
        id: COMMAND_IDS.findIncomingLinks,
        title: 'Find Incoming Links',
        category: 'Links',
        keywords: ['what refers to this'],
        handler: async (args) =>
          this.#showReferences({ entity: this.#subject(args), direction: 'incoming' }),
      },
      {
        id: COMMAND_IDS.findOutgoingLinks,
        title: 'Find Outgoing Links',
        category: 'Links',
        keywords: ['what does this refer to'],
        handler: async (args) =>
          this.#showReferences({ entity: this.#subject(args), direction: 'outgoing' }),
      },
      {
        id: COMMAND_IDS.findAllLinksOfType,
        title: 'Find All Links of This Type',
        category: 'Links',
        keywords: ['same kind', 'link type'],
        handler: async (args) => {
          const linkType = args['linkType'];
          if (typeof linkType !== 'string') {
            throw new WorkbenchError('findAllLinksOfType requires a `linkType` argument');
          }
          return this.#showReferences({
            entity: this.#subject(args),
            direction: 'both',
            linkType,
          });
        },
      },
      {
        id: COMMAND_IDS.openBacklinks,
        title: 'Open Backlinks Panel',
        category: 'Links',
        handler: async (args) => {
          const entity = this.#subject(args);
          const plan = resolveOpen(
            {
              descriptor: {
                kind: 'backlinks',
                entityId: entity.entityId,
                entityType: entity.entityType,
              },
              mode: 'side',
            },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.openLinkGraph,
        title: 'Open Link Graph',
        category: 'Links',
        // The graph always opens *on* something: the entity the user is looking at is the
        // seed, and the panel asks the main process for its neighbourhood. There is no
        // "show me everything" form, here or on the IPC channel behind it.
        //
        // Which makes the empty workspace a real case, not an edge one: the activity bar's
        // Graph button is always enabled, and pressing it with nothing open used to report
        // `no entity to act on` — true, and useless. Saying what would make it work is the
        // whole of criterion U05 (`#subjectOr` below).
        handler: async (args) => {
          const entity = this.#subjectOr(
            args,
            'Open a document or select a highlight first — the graph opens on what you are looking at.',
          );
          // No depth here: how far the graph reaches is a persisted view setting the panel
          // reads, not something the command that opens it decides (`G02`).
          const plan = resolveOpen(
            {
              descriptor: {
                kind: 'link-graph',
                seedEntityId: entity.entityId,
                seedEntityType: entity.entityType,
              },
              mode: modeFromArgs(args, 'side'),
            },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.openWiki,
        title: 'Open Wiki',
        category: 'Links',
        keywords: ['whole graph', 'map', 'everything', 'library graph', 'all files'],
        // A page, not a sidecar (`F01`). The graph panel above is opened *on* something and
        // stays a companion to what you are reading; this is the library itself, so it wants
        // the width of a document and opens where a document would. It takes no subject,
        // because taking one is what would make it the other thing.
        handler: async (args) => {
          const plan = resolveOpen(
            { descriptor: { kind: 'wiki' }, mode: modeFromArgs(args, 'current') },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.openFocusView,
        title: 'Open Focused View',
        category: 'Links',
        keywords: ['focus', 'around this file', 'what this leads to', 'crawl'],
        // One file in the middle, what it says around it, where it leads at the edges
        // (`F02`). Opened on a *file*: a highlight focuses the paper it was made in, because
        // the view's subject is the paper and the highlight is one of the things in it.
        //
        // Always the same tab. Choosing a file at the edge re-seats this view rather than
        // opening another (`F03`), and so does running the command again from a second file —
        // which is what `RESEATED_PANEL_KINDS` is for.
        handler: async (args) => {
          const entity = this.#subjectOr(
            args,
            'Open a file first — the focused view is a view of one file and what it reaches.',
          );
          const documentId =
            entity.entityType === 'document' ? entity.entityId : (entity.documentId ?? null);
          if (documentId === null) {
            throw new WorkbenchError(
              'The focused view opens on a file. Open one, or pick a highlight in one.',
            );
          }
          const plan = resolveOpen(
            {
              descriptor: { kind: 'focus', documentId },
              mode: modeFromArgs(args, 'side'),
            },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.openLedger,
        title: 'Show This File’s Links',
        category: 'Links',
        keywords: ['ledger', 'connections', 'what links here', 'relationships'],
        // Every edge on the file *and* on the sentences marked in it, in one page (`H03`).
        // Opened on a file for the reason the focused view is: the ledger's subject is the
        // paper, and a highlight in it is one of the things the page accounts for.
        handler: async (args) => {
          const entity = this.#subjectOr(
            args,
            'Open a file first — a ledger is the account of one file’s links.',
          );
          const documentId =
            entity.entityType === 'document' ? entity.entityId : (entity.documentId ?? null);
          if (documentId === null) {
            throw new WorkbenchError('A ledger opens on a file. Open one, or pick a highlight in one.');
          }
          const plan = resolveOpen(
            { descriptor: { kind: 'ledger', documentId }, mode: modeFromArgs(args, 'side') },
            host.getWorkspace(),
          );
          await host.applyPlan(plan);
          return plan;
        },
      },
      {
        id: COMMAND_IDS.goBack,
        title: 'Go Back',
        category: 'Navigation',
        when: 'canGoBack',
        handler: async () => this.#restore(this.history.back()),
      },
      {
        id: COMMAND_IDS.goForward,
        title: 'Go Forward',
        category: 'Navigation',
        when: 'canGoForward',
        handler: async () => this.#restore(this.history.forward()),
      },
      {
        id: COMMAND_IDS.goToNextReference,
        title: 'Go to Next Reference',
        category: 'Links',
        handler: async () => host.stepReference(1),
      },
      {
        id: COMMAND_IDS.goToPreviousReference,
        title: 'Go to Previous Reference',
        category: 'Links',
        handler: async () => host.stepReference(-1),
      },
      {
        id: COMMAND_IDS.copyInternalLink,
        title: 'Copy Internal Link',
        category: 'Links',
        keywords: ['copy url', 'share link'],
        handler: async (args) => {
          const entity = this.#subject(args);
          const link = internalLinkFor(entity);
          if (link === null) {
            throw new WorkbenchError(`\`${entity.entityType}\` has no internal link form`);
          }
          await host.copyToClipboard(link);
          return link;
        },
      },
      {
        id: COMMAND_IDS.revealInLibrary,
        title: 'Reveal in Library',
        category: 'View',
        keywords: ['show in sidebar', 'locate'],
        handler: async (args) => host.revealInLibrary(this.#subject(args)),
      },
      {
        id: COMMAND_IDS.showCommands,
        title: 'Show All Commands',
        category: 'View',
        keywords: ['command palette', 'keyboard shortcuts', 'keybindings', 'what can I do'],
        handler: async () => host.showCommands(true),
      },
      {
        id: COMMAND_IDS.linkToDocument,
        title: 'Link This to…',
        category: 'Links',
        keywords: ['relate', 'cite', 'connect', 'typed relationship', 'link highlight'],
        // Opens the picker rather than writing anything: the *other* end and the relationship
        // are both the researcher's to choose, and neither can be guessed from context.
        handler: async (args) => host.promptEntityLink(this.#linkSubject(args)),
      },
      {
        id: COMMAND_IDS.createDocumentLink,
        title: 'Create Link',
        category: 'Links',
        handler: async (args) => {
          const targetId = args['targetId'];
          if (typeof targetId !== 'string' || targetId === '') {
            throw new WorkbenchError('Choose what to link to.');
          }
          const linkType = args['linkType'];
          if (typeof linkType !== 'string' || linkType === '') {
            // No fallback type. `related-to` would be a lie about a relationship the
            // researcher never named, and it would be indistinguishable afterwards from one
            // they did.
            throw new WorkbenchError('Choose what the relationship is before making the link.');
          }
          const rawTargetType = args['targetType'];
          const targetType: LinkableEntityType =
            typeof rawTargetType === 'string' && rawTargetType !== ''
              ? (rawTargetType as LinkableEntityType)
              : 'document';
          const source = this.#linkSubject(args);
          if (source.entityType === targetType && source.entityId === targetId) {
            throw new WorkbenchError('Nothing can be linked to itself.');
          }
          // The picker and the command agree about what may be said between these two ends,
          // because they read it from the same place. A type nobody offered arriving here is
          // a caller inventing a relationship, not a researcher choosing one.
          if (!linkTypesFor(source.entityType, targetType).includes(linkType)) {
            throw new WorkbenchError(
              `“${linkTypeLabel(linkType)}” is not a relationship between those two things.`,
            );
          }
          return host.createEntityLink({
            source,
            target: { entityId: targetId, entityType: targetType },
            type: linkType,
          });
        },
      },
      {
        id: COMMAND_IDS.newNoteFromHere,
        title: 'New Note from Here',
        category: 'Notes',
        keywords: ['write', 'note on this', 'note on highlight'],
        handler: async (args) => {
          // The selected highlight if there is one, else the open document — which is what
          // `getActiveEntity` already means. Not `#subject`: a note is made from where you
          // are, not from whatever the pointer happens to be over.
          const entity = entityFromArgs(args) ?? host.getActiveEntity();
          if (
            entity === null ||
            (entity.entityType !== 'document' && entity.entityType !== 'annotation')
          ) {
            throw new WorkbenchError(
              'Open a document or select a highlight first — a note is made from what you are reading.',
            );
          }
          const noteId = await host.createNoteFrom(entity);
          if (noteId === null) return null;
          return this.navigate({ entityId: noteId, entityType: 'note' }, 'side');
        },
      },
    ];
  }

  /**
   * Recompute the context keys the workbench derives itself. Panels set focus keys; this
   * fills in the ones that depend on data, so `canGoToParent` is right before the user
   * presses the key rather than after.
   */
  async refreshDerivedContext(): Promise<void> {
    this.#syncHistoryContext();

    const entity = this.#host.getActiveEntity();
    const underCursor = this.#host.getLinkUnderCursor();

    this.contextKeys.setMany({
      linkUnderCursor: underCursor !== null,
      documentSelected: entity?.entityType === 'document',
      annotationSelected: entity?.entityType === 'annotation',
      canGoToParent:
        entity === null ? false : hasParent(entity, await this.#host.getLinks(entity)),
    });
  }
}
