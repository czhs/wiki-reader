/**
 * The compiler, asked the questions the window cannot ask it (criteria S02, S04, S05).
 *
 * The compiler runs in the **main process** by design, which is why `S04`'s local-first
 * evidence could not live in the renderer: `performance.getEntriesByType('resource')` is the
 * window's own timeline, and a tarball fetched by a native addon in another process can never
 * appear in it. That assertion was structurally incapable of failing for the thing it was
 * named after, and the milestone-8 audit then drove three spellings of `#import "@preview/…"`
 * straight past the guard beside it. So the guard is asserted *here*, in the process that
 * would do the fetching, over the spellings that got past.
 *
 * The other two are about what a compile is made of: that an equation inside a sentence stays
 * inside it, and that a header rule reaches the page rather than being accepted and ignored.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TypstNode } from '@wr/shared-types';
import { IntegrationWorkspace } from './support/workspace.js';

class Workspace extends IntegrationWorkspace {
  constructor() {
    super('wr-typst-');
  }
}

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(() => {
  workspace.dispose();
});

/** Every element in a compiled tree, flattened, so a shape can be asked about by class. */
function elements(node: TypstNode | null): { tag: string; class: string; text: string }[] {
  if (node === null || node.type !== 'element') return [];
  const text = (child: TypstNode): string =>
    child.type === 'text' ? child.value : (child.children ?? []).map(text).join('');
  return [
    { tag: node.tag, class: node.props?.['class'] ?? '', text: text(node) },
    ...(node.children ?? []).flatMap(elements),
  ];
}

describe('the network guard', () => {
  // The literal spelling is the one the old regex caught; the other three are the ones the
  // audit measured reaching `packages.typst.org` in ~700 ms apiece.
  it.each([
    '#import "@preview/cetz:0.2.2": *',
    '#import "\\u{40}preview/cetz:0.2.2": *',
    '#import "@pre" + "view/cetz:0.2.2": *',
    '#import "@wraudit/thing:0.1.0": *',
  ])(
    '[S04] refuses %j in the process that would fetch it, before the compiler sees it',
    async (source) => {
      const answer = await workspace.call('typst:render', {
        questionId: null,
        source,
        target: 'html',
        widthPt: 480,
      });
      expect(answer.error).toContain('refused here');
      expect(answer.tree).toBeNull();
    },
  );

  it('[S04] refuses an import that arrived in a stored header rather than in the request', async () => {
    // The header is compiled into every block of every notebook, so a guard that only reads
    // the request is a guard over two thirds of what runs.
    workspace.services.db.settings.set('typst.settings', {
      globalHeader: '#import "@preview/cetz:0.2.2": *',
      stackedPlacement: 'below',
    });
    const answer = await workspace.call('typst:render', {
      questionId: null,
      source: '= Method',
      target: 'html',
      widthPt: 480,
    });
    expect(answer.error).toContain('refused here');
  });
});

describe('what a compile is made of', () => {
  it('[S02] keeps an inline equation inside its sentence and gives a display one its own line', async () => {
    const answer = await workspace.call('typst:render', {
      questionId: null,
      source:
        'Retention decays as $R = e^(-t/S)$, so the schedule solves\n$ max_Delta sum_(i=1)^n R(t_i) $',
      target: 'html',
      widthPt: 480,
    });
    expect(answer.error).toBeNull();
    const found = elements(answer.tree);
    // The sentence is one paragraph, comma and all — `html.frame` on its own is block level,
    // which broke it into three stacked pieces.
    const sentence = found.find(
      (element) => element.tag === 'p' && element.text.includes('Retention decays as'),
    );
    expect(sentence?.text).toContain(', so the schedule solves');
    expect(found.filter((element) => element.class.includes('typst-math-inline'))).toHaveLength(1);
    expect(found.filter((element) => element.class.includes('typst-math-block'))).toHaveLength(1);
  });

  it('[S05] applies a show rule written in the global header, and lets the local one build on it', async () => {
    const { question } = await workspace.call('question:create', { title: 'Where headers apply' });
    const settings = await workspace.call('typst:setSettings', {
      globalHeader: '#let claim(b) = [C: #b]\n#show heading: it => [SHOW: #it.body]',
    });
    expect(settings.error).toBeNull();
    const header = await workspace.call('notebook:writeHeader', {
      questionId: question.id,
      header: '#let loud(b) = claim(strong(b))',
    });
    expect(header.error).toBeNull();

    const answer = await workspace.call('typst:render', {
      questionId: question.id,
      source: '= Method\n\n#loud[spacing]',
      target: 'html',
      widthPt: 480,
    });
    expect(answer.error).toBeNull();
    const text = elements(answer.tree)[0]?.text ?? '';
    // A wildcard import brought the bindings and dropped the rule on the floor: this said
    // "Method", with no sign that anything had been ignored.
    expect(text).toContain('SHOW: Method');
    expect(text).toContain('C: spacing');
  });
});
