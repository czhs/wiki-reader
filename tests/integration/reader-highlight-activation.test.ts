/**
 * @vitest-environment jsdom
 *
 * Opening a highlight from the page it is painted on (criterion U06), in the markdown reader.
 *
 * The PDF reader's half of `U06` is an end-to-end test: it needs PDF.js to lay out real glyphs
 * before there are rectangles to click. The markdown reader has no such dependency — its
 * highlights are `<mark>` elements in the rendered document — so its half is proved here,
 * against the real component, in milliseconds rather than in a whole Electron launch.
 *
 * What is under test is the delegation: a click anywhere inside a highlight names that
 * highlight, a click beside one names nothing, and a click that ended a text selection names
 * nothing at all. The last case is the one worth having — the reader must not treat the end of
 * a drag as a request to open whatever the pointer stopped over, or selecting a passage that
 * overlaps an existing highlight would pop the editor open every time.
 *
 * `fetch` is stubbed because `rrfile://` is an Electron protocol and this is jsdom. It returns
 * the same bytes the protocol would; nothing else about the component is replaced.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationWithAnchor, MarkdownAnchor } from '@wr/shared-types';
// By path, as the other integration suites do: the package entrypoint is built for the
// renderer bundle, and the component's source is what is under test.
import { MarkdownReaderView } from '../../packages/markdown-reader/src/MarkdownReaderView.js';

const SOURCE = [
  '# Spaced repetition',
  '',
  'Intervals grow after each successful recall, which is the whole mechanism.',
  '',
].join('\n');

const QUOTE = 'Intervals grow after each successful recall';
const ANNOTATION_ID = 'ann_markdown_1';

function anchor(): MarkdownAnchor {
  return {
    kind: 'markdown',
    version: 1,
    quote: { exact: QUOTE, prefix: '', suffix: ', which is the whole mechanism.' },
    position: { start: 0, end: QUOTE.length },
    documentTextHash: 'text-hash',
    sourceHash: 'source-hash',
    normalizationVersion: 1,
  };
}

function annotation(): AnnotationWithAnchor {
  return {
    id: ANNOTATION_ID,
    documentId: 'doc_1',
    kind: 'highlight',
    color: 'ochre',
    selectedText: QUOTE,
    comment: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    anchor: anchor(),
  } as AnnotationWithAnchor;
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React only treats `act` as a real batching boundary when it is told it is under test.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(SOURCE, { status: 200 }))),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

/** Render the reader and wait for its `rrfile://` read to settle. */
async function render(onActivateHighlight: (id: string | null) => void): Promise<void> {
  await act(async () => {
    root.render(
      createElement(MarkdownReaderView, {
        documentId: 'doc_1',
        fileUrl: 'rrfile://file_1/page.md',
        annotations: [annotation()],
        onActivateHighlight,
      }),
    );
    await Promise.resolve();
  });
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('opening a highlight from the markdown reader', () => {
  it('[U06] names the highlight a click landed in', async () => {
    const activated: (string | null)[] = [];
    await render((id) => activated.push(id));

    const mark = container.querySelector(`[data-testid="markdown-highlight-${ANNOTATION_ID}"]`);
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe(QUOTE);
    if (mark === null) return;

    // Dispatched on a text node's element inside the mark, not on the mark itself: a real
    // click lands on whatever is deepest under the pointer, and the reader has to walk up.
    click(mark);
    expect(activated).toEqual([ANNOTATION_ID]);
  });

  it('[U06] names nothing for a click beside a highlight', async () => {
    const activated: (string | null)[] = [];
    await render((id) => activated.push(id));

    const heading = container.querySelector('h1');
    expect(heading).not.toBeNull();
    if (heading === null) return;

    click(heading);
    expect(activated).toEqual([null]);
  });

  it('[U06] ignores the click that ends a text selection', async () => {
    const activated: (string | null)[] = [];
    await render((id) => activated.push(id));

    const mark = container.querySelector(`[data-testid="markdown-highlight-${ANNOTATION_ID}"]`);
    expect(mark).not.toBeNull();
    if (mark === null) return;

    // Select the highlighted words, the way dragging across them would.
    const range = document.createRange();
    range.selectNodeContents(mark);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.isCollapsed).toBe(false);

    click(mark);
    expect(activated).toEqual([]);
  });
});
