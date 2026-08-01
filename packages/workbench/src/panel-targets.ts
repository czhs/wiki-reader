import type { DocumentId, DocumentLocation } from '@wr/shared-types';
import { isReaderPanelKind, type PanelDescriptor, type PanelKind } from './layout.js';

/**
 * Where a navigation lands: the current pane, the pane beside it, or a new tab.
 *
 * This module decides *what* should happen and returns a plan; the Dockview adapter in the
 * renderer carries it out. Keeping the decision pure means the interesting rules — reuse an
 * already-open document instead of opening it twice, split when there is nowhere to the
 * side to go — are unit-testable without mounting a workspace.
 *
 * Criterion L07: open-current and open-to-side actions.
 */

export type OpenMode = 'current' | 'side' | 'new-tab';

/**
 * Panels the workspace keeps exactly one of. Opening the library twice is never what the
 * user meant; opening a second PDF often is.
 */
const SINGLETON_PANEL_KINDS: readonly PanelKind[] = [
  'library',
  'search-results',
  'annotation-list',
  'document-outline',
  'backlinks',
  'references',
  'link-results',
  // One directory: it is the whole shelf, and a second copy of it is the same shelf.
  'notebook-directory',
  // One wiki: it is the whole library, and a second copy of it is the same library.
  'wiki',
  // One focused view, however many files are looked at through it (`F03`). See below.
  'focus',
];

/**
 * Panels that serve every subject through one tab, and are therefore *re-seated* when a
 * navigation reveals them rather than left showing what they were showing.
 *
 * The focused view is the case this exists for. `F03` asks for a view that crawls: choosing a
 * file at the edge refocuses on it *in the same view*, and opening the focused view on a second
 * file from anywhere else has to mean the same thing. A reveal that kept the old descriptor
 * would leave the tab on the previous file — the failure is silent, which is what makes it
 * worth naming a rule for rather than fixing at one call site.
 *
 * Deliberately not every singleton. A revealed reader keeps its descriptor because that
 * descriptor holds the zoom and the reading position the panel has since accumulated, and the
 * location being navigated to travels on the plan instead. A panel belongs here only when its
 * descriptor *is* the subject, with nothing on it the panel itself has earned.
 */
const RESEATED_PANEL_KINDS: readonly PanelKind[] = ['focus'];

export function isReseatedPanel(descriptor: PanelDescriptor): boolean {
  return RESEATED_PANEL_KINDS.includes(descriptor.kind);
}

/**
 * Identity of what a panel is showing. Two panels with the same subject key are showing
 * the same thing and one can be reused for the other.
 */
export function panelSubjectKey(descriptor: PanelDescriptor): string {
  switch (descriptor.kind) {
    case 'pdf-reader':
    case 'article-reader':
    case 'markdown-reader':
      // Keyed by document, not by kind: without the id every markdown page would be "the
      // same thing" and opening a second one would reveal the panel showing the first.
      return `${descriptor.kind}:${descriptor.documentId}`;
    case 'note-editor':
      return `note-editor:${descriptor.noteId}`;
    case 'notebook':
      // Two notebooks are two pages, for the same reason two documents are two readers.
      return `notebook:${descriptor.questionId}`;
    case 'focus':
      // Keyed by kind and *not* by the file, which is the opposite of the reader above and is
      // the whole mechanism of `F03`: every file is looked at through the same view, so a
      // second file is a re-seat of that one tab rather than a second tab. What re-seats it is
      // `RESEATED_PANEL_KINDS`.
      return 'focus';
    case 'journal':
      // One journal per notebook, however many days it shows: the calendar moves the page
      // from day to day, so opening this notebook's journal twice is the same page twice —
      // but another notebook's journal is another log entirely (`P02`).
      return `journal:${descriptor.questionId}`;
    default:
      return descriptor.kind;
  }
}

export function isSingletonPanel(descriptor: PanelDescriptor): boolean {
  return SINGLETON_PANEL_KINDS.includes(descriptor.kind);
}

export interface PanelPlacement {
  readonly panelId: string;
  readonly groupId: string;
  readonly descriptor: PanelDescriptor;
}

/** What the workspace looks like right now, as far as target resolution cares. */
export interface WorkspaceSnapshot {
  readonly panels: readonly PanelPlacement[];
  /** Group ids in visual order, left to right. */
  readonly groupIds: readonly string[];
  readonly activeGroupId: string | null;
  readonly activePanelId: string | null;
}

export interface OpenRequest {
  readonly descriptor: PanelDescriptor;
  readonly mode: OpenMode;
  /** Location to reveal once the panel exists. */
  readonly location?: DocumentLocation | null;
  /** Keep focus where it is; used by preview-style navigation. */
  readonly preserveFocus?: boolean;
}

export type OpenPlan =
  /** The subject is already open somewhere usable: focus it and reveal the location. */
  | {
      readonly action: 'reveal';
      readonly panelId: string;
      readonly groupId: string;
      readonly location: DocumentLocation | null;
      readonly focus: boolean;
      /**
       * The descriptor to re-seat the revealed panel with, or `null` to leave it alone.
       *
       * Non-null only for a re-seated kind — see `RESEATED_PANEL_KINDS`. Everything else is
       * revealed as it stands, so a reader keeps the zoom and position it has earned.
       */
      readonly descriptor: PanelDescriptor | null;
    }
  /** Add a panel to an existing group. */
  | {
      readonly action: 'open';
      readonly panelId: string;
      readonly groupId: string;
      readonly descriptor: PanelDescriptor;
      readonly location: DocumentLocation | null;
      readonly focus: boolean;
    }
  /** Nothing to the side yet: split off a new group next to the reference group. */
  | {
      readonly action: 'split';
      readonly panelId: string;
      readonly referenceGroupId: string | null;
      readonly direction: 'right';
      readonly descriptor: PanelDescriptor;
      readonly location: DocumentLocation | null;
      readonly focus: boolean;
    };

export interface ResolveOpenOptions {
  /** Panel id factory. Defaults to the subject key, suffixed when a duplicate is wanted. */
  readonly newPanelId?: (descriptor: PanelDescriptor, existingIds: readonly string[]) => string;
}

function defaultPanelId(descriptor: PanelDescriptor, existingIds: readonly string[]): string {
  const base = panelSubjectKey(descriptor);
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}#${suffix}`)) suffix += 1;
  return `${base}#${suffix}`;
}

/** The group to the side of `groupId`, or `null` when it is the only/last group. */
function groupBeside(snapshot: WorkspaceSnapshot, groupId: string | null): string | null {
  if (snapshot.groupIds.length < 2) return null;
  if (groupId === null) return snapshot.groupIds[1] ?? null;
  const index = snapshot.groupIds.indexOf(groupId);
  if (index < 0) return snapshot.groupIds.find((id) => id !== groupId) ?? null;
  return snapshot.groupIds[index + 1] ?? snapshot.groupIds[index - 1] ?? null;
}

/**
 * Resolve an open request into a concrete plan.
 *
 * Reuse rules:
 * - `current` and `side` reuse an existing panel for the same subject. `side` only accepts
 *   one that is *not* in the active group, otherwise "open to the side" would refocus the
 *   pane the user is already in and nothing would appear beside it.
 * - `new-tab` never reuses a reader panel — a second view of the same PDF is legitimate —
 *   but still reuses singletons, because two library trees are not.
 */
export function resolveOpen(
  request: OpenRequest,
  snapshot: WorkspaceSnapshot,
  options: ResolveOpenOptions = {},
): OpenPlan {
  const location = request.location ?? null;
  const focus = request.preserveFocus !== true;
  const subject = panelSubjectKey(request.descriptor);
  const singleton = isSingletonPanel(request.descriptor);

  const matches = snapshot.panels.filter(
    (panel) => panelSubjectKey(panel.descriptor) === subject,
  );

  const mayReuse = request.mode !== 'new-tab' || singleton;
  if (mayReuse && matches.length > 0) {
    const reusable =
      request.mode === 'side'
        ? (matches.find((panel) => panel.groupId !== snapshot.activeGroupId) ??
          (singleton ? matches[0] : undefined))
        : matches[0];

    if (reusable !== undefined) {
      return {
        action: 'reveal',
        panelId: reusable.panelId,
        groupId: reusable.groupId,
        location,
        focus,
        descriptor: isReseatedPanel(request.descriptor) ? request.descriptor : null,
      };
    }
  }

  const existingIds = snapshot.panels.map((panel) => panel.panelId);
  const panelId = (options.newPanelId ?? defaultPanelId)(request.descriptor, existingIds);

  if (request.mode === 'side') {
    const beside = groupBeside(snapshot, snapshot.activeGroupId);
    if (beside !== null) {
      return {
        action: 'open',
        panelId,
        groupId: beside,
        descriptor: request.descriptor,
        location,
        focus,
      };
    }
    return {
      action: 'split',
      panelId,
      referenceGroupId: snapshot.activeGroupId,
      direction: 'right',
      descriptor: request.descriptor,
      location,
      focus,
    };
  }

  const targetGroup = snapshot.activeGroupId ?? snapshot.groupIds[0] ?? null;
  if (targetGroup === null) {
    return {
      action: 'split',
      panelId,
      referenceGroupId: null,
      direction: 'right',
      descriptor: request.descriptor,
      location,
      focus,
    };
  }

  return {
    action: 'open',
    panelId,
    groupId: targetGroup,
    descriptor: request.descriptor,
    location,
    focus,
  };
}

/**
 * Apply a plan to a snapshot. The renderer's Dockview adapter is the real implementation;
 * this mirrors it so tests can assert on a sequence of opens without a DOM.
 */
export function applyOpenPlan(snapshot: WorkspaceSnapshot, plan: OpenPlan): WorkspaceSnapshot {
  switch (plan.action) {
    case 'reveal': {
      const reseated =
        plan.descriptor === null
          ? snapshot.panels
          : snapshot.panels.map((panel) =>
              panel.panelId === plan.panelId && plan.descriptor !== null
                ? { ...panel, descriptor: plan.descriptor }
                : panel,
            );
      const moved = { ...snapshot, panels: reseated };
      return plan.focus
        ? { ...moved, activeGroupId: plan.groupId, activePanelId: plan.panelId }
        : moved;
    }
    case 'open': {
      const panels = [
        ...snapshot.panels,
        { panelId: plan.panelId, groupId: plan.groupId, descriptor: plan.descriptor },
      ];
      return {
        panels,
        groupIds: snapshot.groupIds,
        activeGroupId: plan.focus ? plan.groupId : snapshot.activeGroupId,
        activePanelId: plan.focus ? plan.panelId : snapshot.activePanelId,
      };
    }
    case 'split': {
      const groupId = `group-${snapshot.groupIds.length + 1}`;
      const referenceIndex =
        plan.referenceGroupId === null ? -1 : snapshot.groupIds.indexOf(plan.referenceGroupId);
      const groupIds = [...snapshot.groupIds];
      if (referenceIndex < 0) groupIds.push(groupId);
      else groupIds.splice(referenceIndex + 1, 0, groupId);

      return {
        panels: [
          ...snapshot.panels,
          { panelId: plan.panelId, groupId, descriptor: plan.descriptor },
        ],
        groupIds,
        activeGroupId: plan.focus ? groupId : snapshot.activeGroupId,
        activePanelId: plan.focus ? plan.panelId : snapshot.activePanelId,
      };
    }
    default: {
      const exhaustive: never = plan;
      throw new Error(`unhandled open plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** An empty workspace with a single group, the state the app starts in. */
export function emptyWorkspaceSnapshot(groupId = 'group-1'): WorkspaceSnapshot {
  return { panels: [], groupIds: [groupId], activeGroupId: groupId, activePanelId: null };
}

/** Build the panel descriptor that shows a document, choosing the reader by type. */
export function readerDescriptorFor(
  documentId: DocumentId,
  documentType: 'pdf' | 'webpage' | 'markdown',
  location: DocumentLocation | null = null,
): PanelDescriptor {
  switch (documentType) {
    case 'pdf':
      return { kind: 'pdf-reader', documentId, location, zoom: null };
    case 'markdown':
      return { kind: 'markdown-reader', documentId, location };
    case 'webpage':
      return { kind: 'article-reader', documentId, location, readerMode: 'readability' };
  }
}

/** Whether a plan lands in a reader, used to decide if a location reveal is meaningful. */
export function planTargetsReader(plan: OpenPlan): boolean {
  return plan.action === 'reveal' ? false : isReaderPanelKind(plan.descriptor.kind);
}
