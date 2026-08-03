import { describe, expect, it } from 'vitest';
import type { DocumentId, NavigationLocation, NoteId, WorkspaceLayout } from '@wr/shared-types';
import {
  deserializeWorkspace,
  emptyWorkspace,
  fromWorkspaceLayoutRecord,
  serializeWorkspace,
  toWorkspaceLayoutRecord,
  workspaceFromJson,
  workspaceToJson,
  WORKSPACE_LAYOUT_VERSION,
  type PanelDescriptor,
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

/**
 * A workspace saved before `U15`, restored after it.
 *
 * The left slot, the chrome sizes and the folded flags are gone — every surface is a tab now —
 * so the keys they were persisted under are no longer declared. A restore has to drop them and
 * keep the tabs the researcher had arranged, rather than refusing a layout it half understands.
 */
describe('a workspace from before every surface was a tab', () => {
  it('[U15] restores the panels and drops the retired sidebar and chrome state', () => {
    const restored = deserializeWorkspace({
      ...emptyWorkspace(),
      panels: { 'library': { kind: 'library' } },
      sidebars: { library: true, questions: true, annotations: true, bottomPanel: true },
      chrome: { sizes: { left: 420, annotations: 200, bottom: 300 }, minimized: { left: true } },
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(Object.keys(restored.workspace.panels)).toEqual(['library']);
    expect(restored.workspace).not.toHaveProperty('sidebars');
    expect(restored.workspace).not.toHaveProperty('chrome');
  });
});
