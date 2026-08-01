import { describe, expect, it } from 'vitest';
import type { DocumentId } from '@wr/shared-types';
import {
  applyOpenPlan,
  emptyWorkspaceSnapshot,
  panelSubjectKey,
  readerDescriptorFor,
  resolveOpen,
  type WorkspaceSnapshot,
} from '../src/panel-targets.js';
import type { PanelDescriptor } from '../src/layout.js';

const DOC_A = 'doc_01j0000000000000000000000a' as DocumentId;
const DOC_B = 'doc_01j0000000000000000000000b' as DocumentId;

const readerA = readerDescriptorFor(DOC_A, 'pdf');
const readerB = readerDescriptorFor(DOC_B, 'pdf');

function withPanels(...panels: { panelId: string; groupId: string; descriptor: PanelDescriptor }[]): WorkspaceSnapshot {
  const groupIds = [...new Set(panels.map((panel) => panel.groupId))];
  return {
    panels,
    groupIds: groupIds.length > 0 ? groupIds : ['group-1'],
    activeGroupId: groupIds[0] ?? 'group-1',
    activePanelId: panels[0]?.panelId ?? null,
  };
}

describe('open in the current pane', () => {
  it('[L07] opens a document into the active group', () => {
    const plan = resolveOpen({ descriptor: readerA, mode: 'current' }, emptyWorkspaceSnapshot());

    expect(plan.action).toBe('open');
    if (plan.action !== 'open') return;
    expect(plan.groupId).toBe('group-1');
    expect(plan.descriptor).toEqual(readerA);
    expect(plan.focus).toBe(true);
  });

  it('[L07] reuses an already-open document instead of opening it twice', () => {
    const snapshot = withPanels({ panelId: 'p1', groupId: 'group-1', descriptor: readerA });

    const plan = resolveOpen(
      {
        descriptor: readerA,
        mode: 'current',
        location: { kind: 'pdf', pageIndex: 7 },
      },
      snapshot,
    );

    expect(plan.action).toBe('reveal');
    if (plan.action !== 'reveal') return;
    expect(plan.panelId).toBe('p1');
    expect(plan.location).toEqual({ kind: 'pdf', pageIndex: 7 });
  });

  it('[L07] treats a different document as a different subject', () => {
    const snapshot = withPanels({ panelId: 'p1', groupId: 'group-1', descriptor: readerA });
    const plan = resolveOpen({ descriptor: readerB, mode: 'current' }, snapshot);
    expect(plan.action).toBe('open');
  });

  it('[L07] can preserve focus, for preview-style navigation', () => {
    const plan = resolveOpen(
      { descriptor: readerA, mode: 'current', preserveFocus: true },
      emptyWorkspaceSnapshot(),
    );
    expect(plan.focus).toBe(false);

    const after = applyOpenPlan(emptyWorkspaceSnapshot(), plan);
    expect(after.activePanelId).toBeNull();
    expect(after.panels).toHaveLength(1);
  });
});

describe('open to the side', () => {
  it('[L07] splits when there is only one group', () => {
    const snapshot = withPanels({ panelId: 'p1', groupId: 'group-1', descriptor: readerA });
    const plan = resolveOpen({ descriptor: readerB, mode: 'side' }, snapshot);

    expect(plan.action).toBe('split');
    if (plan.action !== 'split') return;
    expect(plan.referenceGroupId).toBe('group-1');
    expect(plan.direction).toBe('right');
  });

  it('[L07] opens two PDFs side by side, ending with one panel in each group', () => {
    let snapshot = emptyWorkspaceSnapshot();

    snapshot = applyOpenPlan(snapshot, resolveOpen({ descriptor: readerA, mode: 'current' }, snapshot));
    snapshot = applyOpenPlan(snapshot, resolveOpen({ descriptor: readerB, mode: 'side' }, snapshot));

    expect(snapshot.groupIds).toHaveLength(2);
    expect(snapshot.panels).toHaveLength(2);
    const groups = snapshot.panels.map((panel) => panel.groupId);
    expect(new Set(groups).size).toBe(2);
    expect(snapshot.activePanelId).toBe(panelSubjectKey(readerB));
  });

  it('[L07] uses the existing neighbouring group rather than splitting again', () => {
    const snapshot: WorkspaceSnapshot = {
      panels: [
        { panelId: 'p1', groupId: 'group-1', descriptor: readerA },
        { panelId: 'p2', groupId: 'group-2', descriptor: readerB },
      ],
      groupIds: ['group-1', 'group-2'],
      activeGroupId: 'group-1',
      activePanelId: 'p1',
    };

    const plan = resolveOpen(
      { descriptor: { kind: 'note-editor', noteId: 'not_01j0000000000000000000000c' as never, location: null }, mode: 'side' },
      snapshot,
    );

    expect(plan.action).toBe('open');
    if (plan.action !== 'open') return;
    expect(plan.groupId).toBe('group-2');
  });

  it('[L07] focuses an existing panel in the other group instead of duplicating it', () => {
    const snapshot: WorkspaceSnapshot = {
      panels: [
        { panelId: 'p1', groupId: 'group-1', descriptor: readerA },
        { panelId: 'p2', groupId: 'group-2', descriptor: readerB },
      ],
      groupIds: ['group-1', 'group-2'],
      activeGroupId: 'group-1',
      activePanelId: 'p1',
    };

    const plan = resolveOpen({ descriptor: readerB, mode: 'side' }, snapshot);
    expect(plan.action).toBe('reveal');
    if (plan.action !== 'reveal') return;
    expect(plan.panelId).toBe('p2');
    expect(plan.groupId).toBe('group-2');
  });

  it('[L07] does not satisfy open-to-side by refocusing the pane already in front of the user', () => {
    // The document is open, but in the *active* group. Opening it to the side must produce
    // a second view beside it, not silently focus the one already there.
    const snapshot = withPanels({ panelId: 'p1', groupId: 'group-1', descriptor: readerA });
    const plan = resolveOpen({ descriptor: readerA, mode: 'side' }, snapshot);

    expect(plan.action).toBe('split');
    if (plan.action !== 'split') return;
    expect(plan.panelId).not.toBe('p1');
  });
});

describe('panel identity', () => {
  it('[L07] gives readers a per-document subject and singletons a fixed one', () => {
    expect(panelSubjectKey(readerA)).toBe(`pdf-reader:${DOC_A}`);
    expect(panelSubjectKey(readerB)).not.toBe(panelSubjectKey(readerA));
    expect(panelSubjectKey({ kind: 'library', selectedDocumentId: null, expandedCollectionIds: [] })).toBe(
      'library',
    );
  });

  it('[L07] never opens a second library panel, even in new-tab mode', () => {
    const library: PanelDescriptor = {
      kind: 'library',
      selectedDocumentId: null,
      expandedCollectionIds: [],
    };
    const snapshot = withPanels({ panelId: 'library', groupId: 'group-1', descriptor: library });

    expect(resolveOpen({ descriptor: library, mode: 'new-tab' }, snapshot).action).toBe('reveal');
  });

  it('[L07] allows a second view of the same document in new-tab mode', () => {
    const snapshot = withPanels({
      panelId: panelSubjectKey(readerA),
      groupId: 'group-1',
      descriptor: readerA,
    });

    const plan = resolveOpen({ descriptor: readerA, mode: 'new-tab' }, snapshot);
    expect(plan.action).toBe('open');
    if (plan.action !== 'open') return;
    expect(plan.panelId).toBe(`${panelSubjectKey(readerA)}#2`);
  });

  it('[L07] chooses the reader panel kind from the document type', () => {
    expect(readerDescriptorFor(DOC_A, 'pdf').kind).toBe('pdf-reader');
    expect(readerDescriptorFor(DOC_A, 'webpage').kind).toBe('article-reader');
  });

  it('[N08] opens a second question’s notebook rather than revealing the first', () => {
    // Two questions are two pages. Keyed by kind alone, the second question would reveal the
    // panel already showing the first — which looks like the page failing to load.
    const first: PanelDescriptor = { kind: 'notebook', questionId: 'qst_01j000000000000000000000q1' };
    const second: PanelDescriptor = { kind: 'notebook', questionId: 'qst_01j000000000000000000000q2' };
    const snapshot = withPanels({ panelId: 'notebook-1', groupId: 'group-1', descriptor: first });

    expect(resolveOpen({ descriptor: first, mode: 'current' }, snapshot).action).toBe('reveal');
    expect(resolveOpen({ descriptor: second, mode: 'current' }, snapshot).action).toBe('open');
  });
});

/**
 * The one tab that changes what it is showing (`F02`, `F03`).
 *
 * Every other panel is either keyed by its subject — two documents are two readers — or is a
 * singleton with nothing to re-seat. The focused view is neither: one tab, every file, and the
 * act of choosing a file at the edge is the act of re-seating it. The rules that make that work
 * live in target resolution rather than in the panel, because the same thing has to happen when
 * the view is opened on a second file from the reader, the palette or the activity bar.
 */
describe('the focused view', () => {
  const focusOn = (documentId: string): PanelDescriptor => ({ kind: 'focus', documentId });

  it('[F03] re-seats the open view on the new file instead of opening a second one', () => {
    const snapshot = withPanels({
      panelId: 'focus',
      groupId: 'group-1',
      descriptor: focusOn(DOC_A),
    });

    const plan = resolveOpen({ descriptor: focusOn(DOC_B), mode: 'side' }, snapshot);

    expect(plan.action).toBe('reveal');
    if (plan.action !== 'reveal') return;
    expect(plan.panelId).toBe('focus');
    // The half a reveal used to leave out: without a descriptor on the plan the tab stays on
    // the file it was already showing, and the crawl silently does nothing.
    expect(plan.descriptor).toEqual(focusOn(DOC_B));
    const after = applyOpenPlan(snapshot, plan);
    expect(after.panels).toHaveLength(1);
    expect(after.panels[0]?.descriptor).toEqual(focusOn(DOC_B));
  });

  it('[F03] re-seats it even when it is the pane you are already in', () => {
    // `side` normally refuses to reuse a panel in the active group, which for a one-tab view
    // would open `focus#2` and leave two views of two files claiming to be the same one.
    const snapshot: WorkspaceSnapshot = {
      panels: [{ panelId: 'focus', groupId: 'group-1', descriptor: focusOn(DOC_A) }],
      groupIds: ['group-1'],
      activeGroupId: 'group-1',
      activePanelId: 'focus',
    };

    const plan = resolveOpen({ descriptor: focusOn(DOC_B), mode: 'side' }, snapshot);
    expect(plan.action).toBe('reveal');
    if (plan.action !== 'reveal') return;
    expect(plan.panelId).toBe('focus');
  });

  it('[F03] leaves every other revealed panel showing what it was showing', () => {
    // A reader carries a zoom and a reading position it has earned; re-seating it on reveal
    // would throw those away every time a link navigated to the page it is already on.
    const snapshot = withPanels({ panelId: 'reader', groupId: 'group-1', descriptor: readerA });

    const plan = resolveOpen(
      { descriptor: readerDescriptorFor(DOC_A, 'pdf', { kind: 'pdf', pageIndex: 3 }), mode: 'current' },
      snapshot,
    );
    expect(plan.action).toBe('reveal');
    if (plan.action !== 'reveal') return;
    expect(plan.descriptor).toBeNull();
    expect(applyOpenPlan(snapshot, plan).panels[0]?.descriptor).toEqual(readerA);
  });

  it('[F01] keeps one wiki, because a second copy of the library is the same library', () => {
    const wiki: PanelDescriptor = { kind: 'wiki' };
    const snapshot = withPanels({ panelId: 'wiki', groupId: 'group-1', descriptor: wiki });

    expect(resolveOpen({ descriptor: wiki, mode: 'new-tab' }, snapshot).action).toBe('reveal');
    // …and it is not re-seated, because it has no subject to be re-seated on.
    const plan = resolveOpen({ descriptor: wiki, mode: 'current' }, snapshot);
    expect(plan.action === 'reveal' ? plan.descriptor : undefined).toBeNull();
  });
});
