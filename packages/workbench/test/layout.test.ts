import { describe, expect, it } from 'vitest';
import type { DocumentId, NavigationLocation, NoteId, WorkspaceLayout } from '@wr/shared-types';
import {
  deserializeWorkspace,
  emptyWorkspace,
  fromWorkspaceLayoutRecord,
  normaliseSidebars,
  openLeftSidebar,
  serializeWorkspace,
  toggleSidebarState,
  toWorkspaceLayoutRecord,
  workspaceFromJson,
  workspaceToJson,
  WORKSPACE_LAYOUT_VERSION,
  type PanelDescriptor,
  type SidebarState,
} from '../src/layout.js';

const DOC_A = 'doc_01j0000000000000000000000a' as DocumentId;
const DOC_B = 'doc_01j0000000000000000000000b' as DocumentId;
const NOTE_A = 'not_01j0000000000000000000000c' as NoteId;

/** A Dockview blob, shaped like the real thing but opaque to us on purpose. */
const DOCKVIEW_BLOB = {
  grid: {
    root: {
      type: 'branch',
      data: [
        { type: 'leaf', data: { views: ['pdf-reader:doc_a'], activeView: 'pdf-reader:doc_a' }, size: 600 },
        { type: 'leaf', data: { views: ['pdf-reader:doc_b'], activeView: 'pdf-reader:doc_b' }, size: 600 },
      ],
    },
    width: 1200,
    height: 800,
    orientation: 'HORIZONTAL',
  },
  panels: {},
  activeGroup: 'group-1',
};

function fullWorkspace() {
  const panels: Record<string, PanelDescriptor> = {
    'pdf-reader:doc_a': {
      kind: 'pdf-reader',
      documentId: DOC_A,
      location: { kind: 'pdf', pageIndex: 12, pageOffsetRatio: 0.25 },
      zoom: 1.5,
    },
    'pdf-reader:doc_b': {
      kind: 'pdf-reader',
      documentId: DOC_B,
      location: { kind: 'pdf', pageIndex: 3 },
      zoom: null,
    },
    'note-editor:note_a': {
      kind: 'note-editor',
      noteId: NOTE_A,
      location: { kind: 'note', blockIndex: 4 },
    },
    library: { kind: 'library', selectedDocumentId: DOC_A, expandedCollectionIds: ['col_1'] },
    'search-results': {
      kind: 'search-results',
      query: 'attention mechanism',
      filters: null,
      selectedResultIndex: 2,
    },
  };

  const history: NavigationLocation[] = [
    { entityId: DOC_A, entityType: 'document', documentId: DOC_A, timestamp: 1_700_000_000_000 },
    {
      entityId: DOC_B,
      entityType: 'document',
      documentId: DOC_B,
      location: { kind: 'pdf', pageIndex: 3 },
      timestamp: 1_700_000_001_000,
    },
  ];

  return serializeWorkspace({
    dockview: DOCKVIEW_BLOB,
    panels,
    activePanelId: 'pdf-reader:doc_a',
    sidebars: { library: true, annotations: true, bottomPanel: false },
    history: { entries: history, cursor: 1 },
  });
}

describe('workspace layout serialization', () => {
  it('[T10] round-trips a populated workspace through JSON without loss', () => {
    const workspace = fullWorkspace();
    const result = workspaceFromJson(workspaceToJson(workspace));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace).toEqual(workspace);
  });

  it('[T10] preserves per-panel reading state, not just the Dockview geometry', () => {
    const result = workspaceFromJson(workspaceToJson(fullWorkspace()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pdf = result.workspace.panels['pdf-reader:doc_a'];
    expect(pdf).toEqual({
      kind: 'pdf-reader',
      documentId: DOC_A,
      location: { kind: 'pdf', pageIndex: 12, pageOffsetRatio: 0.25 },
      zoom: 1.5,
    });

    const search = result.workspace.panels['search-results'];
    expect(search).toMatchObject({ kind: 'search-results', query: 'attention mechanism', selectedResultIndex: 2 });
  });

  it('[T10] keeps the Dockview blob opaque and byte-identical', () => {
    const result = workspaceFromJson(workspaceToJson(fullWorkspace()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.dockview).toEqual(DOCKVIEW_BLOB);
  });

  it('[T10] restores navigation history with its cursor', () => {
    const result = workspaceFromJson(workspaceToJson(fullWorkspace()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.history.cursor).toBe(1);
    expect(result.workspace.history.entries).toHaveLength(2);
    expect(result.workspace.history.entries[1]?.location).toEqual({ kind: 'pdf', pageIndex: 3 });
  });

  it('[T10] round-trips an empty workspace', () => {
    const result = workspaceFromJson(workspaceToJson(emptyWorkspace()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace).toEqual(emptyWorkspace());
  });

  it('[T10] drops an active panel id that no longer has a panel', () => {
    const workspace = serializeWorkspace({
      dockview: null,
      panels: {},
      activePanelId: 'pdf-reader:gone',
    });
    expect(workspace.activePanelId).toBeNull();

    const salvaged = deserializeWorkspace({
      version: WORKSPACE_LAYOUT_VERSION,
      dockview: null,
      panels: {},
      activePanelId: 'pdf-reader:gone',
      sidebars: { library: true, annotations: false, bottomPanel: false },
      history: { entries: [], cursor: -1 },
    });
    expect(salvaged.ok).toBe(true);
    if (!salvaged.ok) return;
    expect(salvaged.workspace.activePanelId).toBeNull();
    expect(salvaged.warnings[0]).toContain('pdf-reader:gone');
  });

  it('[T10] drops one unparseable panel rather than failing the whole restore', () => {
    const workspace = fullWorkspace();
    const corrupted = {
      ...workspace,
      panels: {
        ...workspace.panels,
        'pdf-reader:broken': { kind: 'pdf-reader', documentId: 'not-a-document-id' },
        'unknown-kind': { kind: 'holographic-reader' },
      },
    };

    const result = deserializeWorkspace(corrupted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.workspace.panels).sort()).toEqual(
      Object.keys(workspace.panels).sort(),
    );
    expect(result.warnings).toHaveLength(2);
  });

  it('[T10] refuses a payload from an incompatible layout version', () => {
    const result = deserializeWorkspace({ ...fullWorkspace(), version: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('version');
  });

  it('[T10] fails cleanly on malformed input instead of throwing', () => {
    for (const input of [null, 'not an object', 42, [], undefined]) {
      const result = deserializeWorkspace(input);
      expect(result.ok).toBe(false);
    }
    const badJson = workspaceFromJson('{ not json');
    expect(badJson.ok).toBe(false);
  });

  it('[T10] round-trips through the persisted WorkspaceLayout record shape', () => {
    const workspace = fullWorkspace();
    const record = toWorkspaceLayoutRecord(workspace, '2026-07-25T00:00:00.000Z');

    expect(record.name).toBe('default');
    expect(record.layout).toEqual(DOCKVIEW_BLOB);

    // The record is what actually lands in SQLite, so it must survive JSON too.
    const persisted = JSON.parse(JSON.stringify(record)) as WorkspaceLayout;
    const restored = fromWorkspaceLayoutRecord(persisted);

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.workspace).toEqual(workspace);
  });

  it('[T10] reports a corrupt panelState column instead of throwing', () => {
    const result = fromWorkspaceLayoutRecord({
      name: 'default',
      layout: null,
      panelState: null as unknown as Record<string, unknown>,
      updatedAt: '2026-07-25T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
  });
});

describe('the left sidebar slot', () => {
  const sidebars = (over: Partial<SidebarState> = {}): SidebarState => ({
    library: false,
    questions: false,
    journal: false,
    librarian: false,
    annotations: false,
    bottomPanel: false,
    ...over,
  });

  it('[U04] opens a left sidebar by replacing the one already open, never beside it', () => {
    let state = sidebars({ library: true });

    for (const which of ['questions', 'journal', 'librarian', 'library'] as const) {
      state = toggleSidebarState(state, which);
      expect(openLeftSidebar(state)).toBe(which);
      // The property the criterion is really about: the reader's width is a function of how
      // many sidebars are open, so "exactly one" is what keeps it from being squeezed.
      const openCount = (['library', 'questions', 'journal', 'librarian'] as const).filter(
        (name) => state[name],
      ).length;
      expect(openCount, `${which} stacked instead of replacing`).toBe(1);
    }
  });

  it('[U04] closes the open sidebar when its own button is pressed again', () => {
    const state = toggleSidebarState(sidebars({ journal: true }), 'journal');
    expect(openLeftSidebar(state)).toBeNull();
    // Still a toggle, not a one-way switch — the reader can have the whole window.
    expect(state.library).toBe(false);
  });

  it('[U04] leaves the right sidebar and the bottom panel independent', () => {
    // These do not share the left slot, so opening the annotations sidebar must not close
    // the library — collapsing everything into one slot would be its own usability bug.
    const state = toggleSidebarState(sidebars({ library: true }), 'annotations');
    expect(state.annotations).toBe(true);
    expect(state.library).toBe(true);

    const withPanel = toggleSidebarState(state, 'bottomPanel');
    expect(withPanel.bottomPanel).toBe(true);
    expect(withPanel.library).toBe(true);
    expect(withPanel.annotations).toBe(true);
  });

  it('[U04] collapses a workspace saved with all four open, so a restart cannot restore it', () => {
    const stacked = sidebars({
      library: true,
      questions: true,
      journal: true,
      librarian: true,
      annotations: true,
    });
    expect(normaliseSidebars(stacked)).toEqual(
      sidebars({ library: true, annotations: true }),
    );

    // And through the real restore path, which is how such a workspace actually comes back.
    const restored = deserializeWorkspace({
      ...emptyWorkspace(),
      sidebars: stacked,
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(openLeftSidebar(restored.workspace.sidebars)).toBe('library');
    expect(restored.workspace.sidebars.questions).toBe(false);
    expect(restored.warnings).toContain('collapsed several open left sidebars to one');
  });
});
