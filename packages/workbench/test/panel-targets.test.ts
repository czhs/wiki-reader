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
