import { NavigationHistory } from '@wr/document-model';
import type { Link, NavigationLocation, ResolvedLink } from '@wr/shared-types';
import {
  CommandRegistry,
  type CommandArgs,
  type CommandDefinition,
  type CommandSearchResult,
} from './commands.js';
import { ContextKeyService, type ContextSnapshot } from './context.js';
import { internalLinkFor, otherEndpoint, type EntityRef } from './entity-links.js';
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
  toggleLibrarySidebar: 'wr.toggleLibrarySidebar',
  toggleQuestionsSidebar: 'wr.toggleQuestionsSidebar',
  toggleJournalSidebar: 'wr.toggleJournalSidebar',
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
  goBack: 'wr.goBack',
  goForward: 'wr.goForward',
  goToNextReference: 'wr.goToNextReference',
  goToPreviousReference: 'wr.goToPreviousReference',
  copyInternalLink: 'wr.copyInternalLink',
  revealInLibrary: 'wr.revealInLibrary',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

export interface ReferenceQuery {
  readonly entity: EntityRef;
  readonly direction: 'incoming' | 'outgoing' | 'both';
  readonly linkType?: string;
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
    which: 'library' | 'questions' | 'journal' | 'annotations' | 'bottomPanel',
  ): void | Promise<void>;
  copyToClipboard(text: string): void | Promise<void>;
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
    const explicit = entityFromArgs(args);
    if (explicit !== null) return explicit;
    const underCursor = this.#host.getLinkUnderCursor();
    if (underCursor !== null) return underCursor;
    const active = this.#host.getActiveEntity();
    if (active !== null) return active;
    throw new WorkbenchError('no entity to act on');
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
        title: 'Toggle Questions Sidebar',
        category: 'View',
        keywords: ['queue', 'research questions'],
        handler: async () => host.toggleSidebar('questions'),
      },
      {
        id: COMMAND_IDS.toggleJournalSidebar,
        title: 'Toggle Journal Sidebar',
        category: 'View',
        keywords: ['diary', 'field journal', 'day entry'],
        handler: async () => host.toggleSidebar('journal'),
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
        handler: async (args) => {
          const entity = this.#subject(args);
          const depth = args['depth'];
          const plan = resolveOpen(
            {
              descriptor: {
                kind: 'link-graph',
                seedEntityId: entity.entityId,
                seedEntityType: entity.entityType,
                depth: typeof depth === 'number' ? depth : 1,
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
