/**
 * Context menus: the command registry, read where the pointer is (criterion `R01`).
 *
 * A menu here is **not a list of actions**. It is a list of command *ids*, and everything the
 * menu shows — the wording, the grouping category, the key that also runs it, whether it is
 * offered at all — is read back out of the two registries at the moment of the click. That is
 * the whole design: a second list of actions would be a second authority, and the first time
 * one moved, a menu would confidently offer something the help page (`D02`) and the guide have
 * never heard of. Adding an item to a menu is therefore impossible without the command
 * existing, and `menus.test.ts` asserts the reverse — that every id below is registered.
 *
 * Three things can keep an entry off a menu, and all three are answered by the registry or by
 * the target rather than by this table:
 *
 * - the command is not registered at all (a typo; the unit test catches it at build time);
 * - its `when` clause does not hold in the current context — a menu *omits* what does not
 *   apply, where the palette greys it, because a menu is a claim about this thing under this
 *   pointer rather than an inventory of the application;
 * - the target cannot supply an argument the command needs, or is the wrong kind of thing for
 *   it. Right-clicking the help tab must not offer "Open to the Side" of a document that is
 *   not there.
 *
 * What is deliberately absent: anything destructive that the surface itself guards. Deleting a
 * notebook is offered on the discarded shelf and nowhere else (`I01`), so no menu offers it —
 * a menu that could reach past a guard would be the guard's second, unguarded door.
 */
import { COMMAND_IDS } from './command-ids.js';
import type { CommandArgs, CommandRegistry } from './commands.js';
import type { ContextSnapshot } from './context.js';

/** The surfaces a right-click means something on. */
export type ContextMenuKind =
  /** A file in the library sidebar. */
  | 'library-row'
  /** One open tab in the centre. */
  | 'tab'
  /** A disc on any of the three graph surfaces. */
  | 'graph-node'
  /** A marked sentence, wherever it is drawn. */
  | 'highlight'
  /** A notebook, on the shelf or in the queue. */
  | 'notebook'
  /** One block of a writing surface — a journal day, a notebook's page. */
  | 'block'
  /** The document in front, right-clicked in the reader itself. */
  | 'reader';

export interface ContextMenuEntry {
  readonly commandId: string;
  /**
   * Argument names the command cannot work without. An entry whose target did not supply one
   * is not offered, rather than being offered and then failing into the status bar.
   */
  readonly requires?: readonly string[];
  /**
   * Entity types the entry makes sense for, matched against the target's `entityType`. Absent
   * means "any". A note cannot be sent to a notebook, so the menu on one does not say it can.
   */
  readonly forTypes?: readonly string[];
}

/** The kinds of thing reading produces, and the only ones that can be sent to a notebook. */
const READING = ['document', 'annotation'] as const;

/**
 * What each surface offers, in groups. Order is the order they are drawn; a group is a rule
 * about separation, not a heading, so the sections read open-it / follow-it / make-something.
 */
export const CONTEXT_MENUS: Readonly<Record<ContextMenuKind, readonly (readonly ContextMenuEntry[])[]>> = {
  'library-row': [
    [
      { commandId: COMMAND_IDS.openDocument, requires: ['entityId'] },
      { commandId: COMMAND_IDS.openToSide, requires: ['entityId'] },
    ],
    [
      { commandId: COMMAND_IDS.openLedger, requires: ['entityId'], forTypes: READING },
      { commandId: COMMAND_IDS.openFocusView, requires: ['entityId'], forTypes: READING },
      { commandId: COMMAND_IDS.findAllReferences, requires: ['entityId'] },
    ],
    [
      { commandId: COMMAND_IDS.linkToDocument, requires: ['sourceId'] },
      { commandId: COMMAND_IDS.sendToNotebook, requires: ['sourceId'], forTypes: READING },
      { commandId: COMMAND_IDS.newNoteFromHere, requires: ['entityId'], forTypes: READING },
      { commandId: COMMAND_IDS.copyInternalLink, requires: ['entityId'] },
    ],
  ],

  // A tab is a *panel*, so the first group acts on the panel and needs no entity at all —
  // which is why the help tab and the wiki tab still have a usable menu. The rest appears only
  // for a tab that is showing something that can be acted on.
  tab: [
    [
      { commandId: COMMAND_IDS.closeTab, requires: ['panelId'] },
      { commandId: COMMAND_IDS.closeGroup, requires: ['groupId'] },
    ],
    [
      { commandId: COMMAND_IDS.openToSide, requires: ['entityId'] },
      { commandId: COMMAND_IDS.openLedger, requires: ['entityId'], forTypes: READING },
      { commandId: COMMAND_IDS.openFocusView, requires: ['entityId'], forTypes: READING },
    ],
    [
      { commandId: COMMAND_IDS.linkToDocument, requires: ['sourceId'] },
      { commandId: COMMAND_IDS.sendToNotebook, requires: ['sourceId'], forTypes: READING },
      { commandId: COMMAND_IDS.copyInternalLink, requires: ['entityId'] },
    ],
  ],

  // The map's nodes are files, marked sentences and whatever else has become structure. What
  // a node offers is what that *kind* of thing offers, which is why `forTypes` does the work
  // here rather than a second menu per node type.
  'graph-node': [
    [
      { commandId: COMMAND_IDS.openDocument, requires: ['entityId'] },
      { commandId: COMMAND_IDS.openToSide, requires: ['entityId'] },
      { commandId: COMMAND_IDS.openFocusView, requires: ['documentId'] },
    ],
    [
      { commandId: COMMAND_IDS.openLedger, requires: ['documentId'] },
      { commandId: COMMAND_IDS.findAllReferences, requires: ['entityId'] },
      { commandId: COMMAND_IDS.openLinkGraph, requires: ['entityId'] },
    ],
    [
      { commandId: COMMAND_IDS.linkToDocument, requires: ['sourceId'] },
      { commandId: COMMAND_IDS.sendToNotebook, requires: ['sourceId'], forTypes: READING },
      { commandId: COMMAND_IDS.copyInternalLink, requires: ['entityId'] },
    ],
  ],

  highlight: [
    [
      { commandId: COMMAND_IDS.openAnnotation, requires: ['entityId'] },
      { commandId: COMMAND_IDS.openLedger, requires: ['documentId'] },
      { commandId: COMMAND_IDS.findAllReferences, requires: ['entityId'] },
    ],
    [
      { commandId: COMMAND_IDS.linkToDocument, requires: ['sourceId'] },
      { commandId: COMMAND_IDS.sendToNotebook, requires: ['sourceId'] },
      { commandId: COMMAND_IDS.newNoteFromHere, requires: ['entityId'] },
      { commandId: COMMAND_IDS.copyInternalLink, requires: ['entityId'] },
    ],
  ],

  // Its two doors, and the shelf they both live on. Not discard and not delete: those are the
  // queue's, guarded and in that order, and a menu is not the place to put an irreversible act
  // one pixel from a reversible one.
  notebook: [
    [
      { commandId: COMMAND_IDS.openNotebook, requires: ['questionId'] },
      { commandId: COMMAND_IDS.openJournal, requires: ['questionId'] },
    ],
    [{ commandId: COMMAND_IDS.openNotebookDirectory }],
  ],

  // Writing. `blockIndex` is which block was clicked, so "add" means *after this one* rather
  // than at the end — the one thing the insert strip at the bottom cannot say. Delete is a
  // group of its own, at the bottom, for the reason every menu here puts a destructive act
  // last: it must not sit one pixel from the thing above it.
  block: [
    [{ commandId: COMMAND_IDS.editBlock, requires: ['blockIndex'] }],
    [
      { commandId: COMMAND_IDS.addTextBlock },
      { commandId: COMMAND_IDS.addCodeBlock },
    ],
    [{ commandId: COMMAND_IDS.deleteBlock, requires: ['blockIndex'] }],
  ],

  // The reader's own background: the same three things its action strip offers, plus the ways
  // out of the file into what it is connected to.
  reader: [
    [
      { commandId: COMMAND_IDS.openLedger, requires: ['entityId'] },
      { commandId: COMMAND_IDS.openFocusView, requires: ['entityId'] },
      { commandId: COMMAND_IDS.findAllReferences, requires: ['entityId'] },
    ],
    [
      { commandId: COMMAND_IDS.linkToDocument, requires: ['sourceId'] },
      { commandId: COMMAND_IDS.sendToNotebook, requires: ['sourceId'], forTypes: READING },
      { commandId: COMMAND_IDS.newNoteFromHere, requires: ['entityId'], forTypes: READING },
      { commandId: COMMAND_IDS.copyInternalLink, requires: ['entityId'] },
    ],
  ],
};

/** One line of a menu: a command, as the registries describe it, plus what to run it on. */
export interface ContextMenuItem {
  readonly commandId: string;
  /** From the command registry — never written here. */
  readonly title: string;
  readonly category: string;
  readonly label: string;
  /** From the keybinding registry, so a menu is also how a chord is learned. */
  readonly chords: readonly string[];
  /** The target's arguments, handed to `commands.execute` unchanged. */
  readonly args: CommandArgs;
}

/** A run of items drawn together, with a rule between it and the next. */
export interface ContextMenuGroup {
  readonly items: readonly ContextMenuItem[];
}

export interface ContextMenuLookup {
  readonly commands: CommandRegistry;
  readonly context: ContextSnapshot;
  /** Chords for a command id, as the keybinding registry currently holds them. */
  readonly chordsFor: (commandId: string) => readonly string[];
}

function satisfies(entry: ContextMenuEntry, args: CommandArgs): boolean {
  for (const name of entry.requires ?? []) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return false;
  }
  if (entry.forTypes === undefined) return true;
  const type = args['entityType'];
  return typeof type === 'string' && entry.forTypes.includes(type);
}

/**
 * The menu for one target: the registry, filtered by this context and these arguments.
 *
 * Empty groups are dropped, so the caller never draws a separator with nothing under it. An
 * empty result means there is nothing to offer here, and the caller should show no menu rather
 * than an empty one.
 */
export function buildContextMenu(
  kind: ContextMenuKind,
  args: CommandArgs,
  lookup: ContextMenuLookup,
): readonly ContextMenuGroup[] {
  const groups: ContextMenuGroup[] = [];

  for (const entries of CONTEXT_MENUS[kind]) {
    const items: ContextMenuItem[] = [];
    for (const entry of entries) {
      const command = lookup.commands.get(entry.commandId);
      if (command === undefined) continue;
      if (!satisfies(entry, args)) continue;
      if (!lookup.commands.isEnabled(entry.commandId, lookup.context)) continue;
      items.push({
        commandId: command.id,
        title: command.title,
        category: command.category,
        label: command.label,
        chords: lookup.chordsFor(command.id),
        args,
      });
    }
    if (items.length > 0) groups.push({ items });
  }

  return groups;
}

/**
 * Every surface a right-click means something on.
 *
 * Read off the table rather than written out again, so the guide (`O01`) — which has to cover
 * all of them — learns about a new surface by the table gaining one.
 */
export function contextMenuKinds(): readonly ContextMenuKind[] {
  return Object.keys(CONTEXT_MENUS) as ContextMenuKind[];
}

/** Every command id any menu can offer. Used by the test that keeps the table honest. */
export function menuCommandIds(): readonly string[] {
  const ids = new Set<string>();
  for (const groups of Object.values(CONTEXT_MENUS)) {
    for (const entries of groups) {
      for (const entry of entries) ids.add(entry.commandId);
    }
  }
  return [...ids];
}
