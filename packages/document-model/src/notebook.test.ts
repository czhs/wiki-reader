/**
 * The notebook body's sections (criterion N02).
 *
 * The four conventional sections are a *template*, not a schema: a page that drops one is
 * still a page, and nothing here may reject or rewrite a body for being shaped differently.
 * What the app guarantees is narrower and more useful — the body is markdown source, and the
 * sections read out of it are exactly what was written under each heading.
 *
 * The fenced-code case is the one that decides the implementation. A regex over lines
 * beginning with `##` invents a section out of a `## heading` inside a code fence; the AST
 * the rest of the app already parses markdown with does not.
 */
import { describe, expect, it } from 'vitest';
import { blankNotebook, notebookSections, NOTEBOOK_TEMPLATE_SECTIONS } from './notebook.js';

describe('notebook sections', () => {
  it('[N02] opens a blank page on the four conventional sections, in order', () => {
    const sections = notebookSections(blankNotebook());

    expect(sections.map((section) => section.heading)).toEqual([...NOTEBOOK_TEMPLATE_SECTIONS]);
    expect(NOTEBOOK_TEMPLATE_SECTIONS).toEqual([
      'What I want to know',
      'Background and prior work',
      'Hypotheses',
      'Experiment log',
    ]);
  });

  it('[N02] carries no title of its own: the notebook owns the title', () => {
    // A `# heading` in the body would be a second place the page's name lives, and the two
    // would drift the first time the question is renamed.
    expect(blankNotebook()).not.toMatch(/^#\s/mu);
    expect(notebookSections(blankNotebook()).every((section) => section.depth === 2)).toBe(true);
  });

  it('[N02] keeps everything written under a section, sub-headings included', () => {
    const body = [
      '## What I want to know',
      '',
      'Do induction heads appear in vision-language models?',
      '',
      '## Background and prior work',
      '',
      'Olsson et al. found them in text-only transformers.',
      '',
      '## Hypotheses',
      '',
      '- Attention-only layers carry the copying behaviour.',
      '',
      '## Experiment log',
      '',
      '### 2026-07-27',
      '',
      'Ran the sweep at width 4096.',
      '',
      '### 2026-07-28',
      '',
      'Repeated it at 8192; the ceiling did not move.',
      '',
    ].join('\n');

    const sections = notebookSections(body);

    expect(sections.map((section) => section.heading)).toEqual([...NOTEBOOK_TEMPLATE_SECTIONS]);
    // The dated sub-headings belong to the log; they are not sections of the page.
    const log = sections[3];
    expect(log?.body).toContain('### 2026-07-27');
    expect(log?.body).toContain('Repeated it at 8192; the ceiling did not move.');
    expect(sections[1]?.body).toBe('Olsson et al. found them in text-only transformers.');
  });

  it('[N02] does not invent a section out of a heading inside a code fence', () => {
    const body = [
      '## What I want to know',
      '',
      'Does the loader mis-parse a fenced heading?',
      '',
      '## Experiment log',
      '',
      'The template, as it is written out:',
      '',
      '```markdown',
      '## Background and prior work',
      '',
      '## Hypotheses',
      '```',
      '',
      'Neither of those is a section of this page.',
      '',
    ].join('\n');

    const sections = notebookSections(body);

    expect(sections.map((section) => section.heading)).toEqual([
      'What I want to know',
      'Experiment log',
    ]);
    expect(sections[1]?.body).toContain('## Hypotheses');
  });

  it('[N02] a page that drops a section is still a page', () => {
    const body = ['## What I want to know', '', 'Is this still a notebook?', '', '## Experiment log', '', 'Yes.', ''].join(
      '\n',
    );

    const sections = notebookSections(body);

    expect(sections.map((section) => section.heading)).toEqual(['What I want to know', 'Experiment log']);
    expect(sections[0]?.body).toBe('Is this still a notebook?');
  });

  it('[N02] a body with no headings at all is one anonymous section', () => {
    // Free prose is a legitimate page. Reporting nothing would make an outline of it
    // impossible; reporting a fabricated heading would put words in the researcher's page.
    const sections = notebookSections('Just thinking out loud.\n');

    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe('');
    expect(sections[0]?.body).toBe('Just thinking out loud.');
  });

  it('[N02] an empty body has no sections', () => {
    expect(notebookSections('')).toEqual([]);
    expect(notebookSections('   \n\n')).toEqual([]);
  });
});
