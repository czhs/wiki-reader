/**
 * @vitest-environment jsdom
 *
 * Highlight colours (criterion W11).
 *
 * The criterion is about three things at once — the colour is one of six presets, it is
 * changed *from the popover*, and it survives a restart — so the test drives all three in one
 * path: the real `AnnotationCard` renders into a real DOM, a real click on a swatch runs the
 * handler the panel wires, the request crosses the real router with its zod validation into a
 * real SQLite file, and the services are then closed and reopened before the colour is read
 * back.
 *
 * Colours are stored by *name*. What the reader paints is a CSS variable derived from that
 * name, which is why the swatch assertions look for `var(--wr-highlight-…)` and never a hex
 * literal: a hex in the database would freeze a highlight at the colour of the theme it was
 * made under.
 *
 * Milestone-1 rows carry hex, and a name could be retired later, so reading is total: an
 * unrecognised stored value renders as `default` rather than failing to render. That decision
 * is asserted here, not left implicit.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_COLORS,
  highlightColorVariable,
  type AnnotationWithAnchor,
  type HighlightColor,
  type MarkdownAnchor,
} from '@wr/shared-types';
// By path, like the other integration suites: the package entrypoint is built for the
// renderer bundle, and what is under test here is the component's source.
import { AnnotationCard } from '../../packages/annotations/src/AnnotationCard.js';
// The renderer's own edit wiring, so this test drives what the panel drives.
import { createAnnotationEdits } from '../../apps/desktop/src/renderer/annotation-actions.js';
import { IntegrationWorkspace } from './support/workspace.js';

const QUOTE = 'Recall is strongest when review is spread out';

class Workspace extends IntegrationWorkspace {
  constructor() {
    super('wr-highlight-color-');
  }
}

let workspace: Workspace;
let container: HTMLDivElement;
let root: Root | null = null;
/** What the edits pushed back into the sidebar store, so a test can assert the re-read. */
let refreshed: { documentId: string; count: number } | null = null;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  // React only treats `act` as a real batching boundary when it is told it is under test.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  workspace = new Workspace();
  container = document.createElement('div');
  document.body.append(container);
  refreshed = null;
});

afterEach(() => {
  if (root !== null) {
    const current = root;
    act(() => {
      current.unmount();
    });
    root = null;
  }
  container.remove();
  workspace.dispose();
});

function markdownAnchor(): MarkdownAnchor {
  return {
    kind: 'markdown',
    version: 1,
    quote: { exact: QUOTE, prefix: '', suffix: ' rather than massed.' },
    position: { start: 0, end: QUOTE.length },
    documentTextHash: 'text-hash',
    sourceHash: 'source-hash',
    normalizationVersion: 1,
  };
}

/** A document with one highlight on it, created through the router like the reader does. */
async function seedHighlight(color: HighlightColor = 'default'): Promise<AnnotationWithAnchor> {
  const document = workspace.services.db.documents.create({
    title: 'Spaced repetition',
    docType: 'markdown',
    source: 'corpus',
    authors: [],
  });
  const { annotation } = await workspace.call('annotation:create', {
    documentId: document.id,
    kind: 'highlight',
    color,
    selectedText: QUOTE,
    comment: null,
    anchor: markdownAnchor(),
  });
  return annotation;
}

interface CardHandlers {
  /** Resolves once the request the last click started has been answered. */
  settled: () => Promise<void>;
}

/**
 * Render the annotation card the sidebar renders, driving the *same* edits `AnnotationsView`
 * drives — `createAnnotationEdits`, imported from the renderer rather than reimplemented here.
 *
 * This used to hand the card its own handlers that called the router directly. They looked
 * like the panel's, so the suite read as though it covered the wiring, but no-op'ing
 * `AnnotationsView`'s handlers left all seven `[W11]` tests passing: the criterion says the
 * colour is changed *from the popover*, and nothing here ran the code that does it.
 */
function renderCard(annotation: AnnotationWithAnchor): CardHandlers {
  let pending: Promise<unknown> = Promise.resolve();
  const edits = createAnnotationEdits(annotation.documentId, {
    call: (channel, request) => workspace.call(channel, request),
    setAnnotations: (documentId, list) => {
      refreshed = { documentId, count: list.length };
    },
    setStatus: (text) => {
      throw new Error(`the panel reported a failure instead of editing: ${text}`);
    },
  });
  const element = createElement(AnnotationCard, {
    annotation,
    resolved: null,
    selected: false,
    noteCount: 0,
    onSelect: () => undefined,
    onAddNote: () => undefined,
    onFindReferences: () => undefined,
    onChangeColor: (color: HighlightColor) => {
      pending = edits.changeColor(annotation.id, color);
    },
    onChangeComment: (comment: string | null) => {
      pending = edits.changeComment(annotation.id, comment);
    },
    onDelete: () => {
      pending = edits.remove(annotation.id);
    },
  });
  const created = createRoot(container);
  root = created;
  act(() => {
    created.render(element);
  });
  return { settled: async () => void (await pending) };
}

function find(testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`no element with data-testid="${testId}"`);
  return element;
}

function click(testId: string): void {
  const element = find(testId);
  act(() => {
    element.click();
  });
}

/** Type into a React-controlled field: React tracks the value, so set it through the setter. */
function type(element: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('no value setter on HTMLTextAreaElement');
  act(() => {
    setter.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Open the popover on the rendered card. */
function openPopover(annotation: AnnotationWithAnchor): void {
  click(`annotation-edit-${annotation.id}`);
}

describe('highlight colours', () => {
  it('[W11] offers exactly the six preset colours in the popover', async () => {
    const annotation = await seedHighlight();
    renderCard(annotation);
    openPopover(annotation);

    // Scoped to the popover: the card's own swatch reports its colour the same way.
    const swatches = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="highlight-popover"] [data-highlight-color]',
      ),
    ].map((element) => element.dataset['highlightColor']);
    expect(swatches).toEqual(['default', 'tan', 'spruce', 'ochre', 'clay', 'signal']);
    expect([...HIGHLIGHT_COLORS]).toEqual(swatches);
  });

  it('[W11] paints each preset from its own CSS variable, never a hex literal', async () => {
    const annotation = await seedHighlight('clay');
    renderCard(annotation);
    openPopover(annotation);

    expect(find(`annotation-swatch-${annotation.id}`).style.background).toContain(
      'var(--wr-highlight-clay)',
    );
    for (const color of HIGHLIGHT_COLORS) {
      expect(find(`highlight-color-${color}`).style.background).toBe(
        highlightColorVariable(color),
      );
    }
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('[W11] changes the colour from the popover, and the colour survives restart', async () => {
    const annotation = await seedHighlight();
    const card = renderCard(annotation);
    openPopover(annotation);

    click('highlight-color-spruce');
    await card.settled();

    workspace.restart();
    const { annotation: reloaded } = await workspace.call('annotation:get', {
      annotationId: annotation.id,
    });
    expect(reloaded.color).toBe('spruce');
    // Re-reading the document's annotations is part of what the panel's edit does, so the
    // sidebar shows the new colour without its own reducer. Assert it ran.
    expect(refreshed).toEqual({ documentId: annotation.documentId, count: 1 });
    // Stored by name: the row itself must not carry a hex value.
    const stored = workspace.services.db.sqlite
      .prepare('SELECT color FROM annotations WHERE id = ?')
      .get(annotation.id) as { color: string };
    expect(stored.color).toBe('spruce');
  });

  it('[W11] edits the comment from the popover, and the comment survives restart', async () => {
    const annotation = await seedHighlight();
    const card = renderCard(annotation);
    openPopover(annotation);

    type(find('highlight-comment') as HTMLTextAreaElement, 'Massed practice feels better.');
    click('highlight-comment-save');
    await card.settled();

    workspace.restart();
    const { annotation: reloaded } = await workspace.call('annotation:get', {
      annotationId: annotation.id,
    });
    expect(reloaded.comment).toBe('Massed practice feels better.');
    expect(reloaded.color).toBe('default');
  });

  it('[W11] deletes the highlight from the popover', async () => {
    const annotation = await seedHighlight();
    const card = renderCard(annotation);
    openPopover(annotation);

    click('highlight-delete');
    await card.settled();

    workspace.restart();
    const { annotations } = await workspace.call('annotation:listByDocument', {
      documentId: annotation.documentId,
    });
    expect(annotations).toEqual([]);
    expect(refreshed).toEqual({ documentId: annotation.documentId, count: 0 });
  });

  it('[W11] refuses a colour that is not one of the six presets', async () => {
    const annotation = await seedHighlight();

    const created = await workspace.attempt('annotation:create', {
      documentId: annotation.documentId,
      kind: 'highlight',
      color: '#ffd54f',
      selectedText: QUOTE,
      comment: null,
      anchor: markdownAnchor(),
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('INVALID_REQUEST');

    const updated = await workspace.attempt('annotation:update', {
      annotationId: annotation.id,
      color: 'purple',
    });
    expect(updated.ok).toBe(false);
    if (!updated.ok) expect(updated.error.code).toBe('INVALID_REQUEST');
  });

  it('[W11] reads a colour stored before the presets existed as the default', async () => {
    const annotation = await seedHighlight();
    // A milestone-1 row: written when the channel took a free-form string.
    workspace.services.db.sqlite
      .prepare('UPDATE annotations SET color = ? WHERE id = ?')
      .run('#ffd54f', annotation.id);

    workspace.restart();
    const { annotation: reloaded } = await workspace.call('annotation:get', {
      annotationId: annotation.id,
    });
    expect(reloaded.color).toBe('default');
    expect(highlightColorVariable(reloaded.color)).toBe('var(--wr-highlight-default)');
  });
});
