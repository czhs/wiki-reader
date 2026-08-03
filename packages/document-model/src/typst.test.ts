/**
 * What the notebook's Typst spellings decide, without a compiler (`S04`–`S06`).
 *
 * This module is pure and string-shaped by design, and until the milestone-8 audit that
 * property was unused: everything it decided was proved only by whatever sentence an E2E
 * happened to type, which is to say by benign fixture prose with no punctuation in it. Two of
 * its functions are security-shaped — `escapeTypstText` is what stops a PDF's text carrying
 * `#link(…)` into the researcher's paper, and `refuseNetworkImports` is what stops the
 * compiler fetching a package — and both are exercised here with the inputs that broke them.
 */
import { describe, expect, it } from 'vitest';
import {
  blankNotebookTypst,
  escapeTypstText,
  excerptTypst,
  parseTypstImage,
  refuseNetworkImports,
  typstOpenDepth,
  typstPrelude,
  typstSections,
  typstString,
  withTypstImageWidth,
} from './typst.js';

const ANNOTATION = 'ann_01j5abcdefghjkmnpqrstvwxyz';
const FILE = 'dfl_01j5abcdefghjkmnpqrstvwxyz';

describe('escapeTypstText', () => {
  // Every character Typst reads inside content, with what it would have done had it survived.
  it.each([
    ['#link("http://evil.example")[click]', 'a construct the quoted document wrote'],
    ['about ~50% of runs', 'a non-breaking space that deletes the tilde'],
    ['a ~ b', 'the same, between words'],
    ['see @smith2020 for the sweep', 'a bibliography reference'],
    ['the $x$ term', 'inline maths'],
    ['*not* emphasis', 'emphasis'],
    ['an _under_ score', 'emphasis again'],
    ['a `raw` word', 'a raw span'],
    ['a <label> in the text', 'a label'],
    ['brackets [like this]', 'a content block'],
    ['a trailing backslash \\', 'the escape itself'],
  ])('escapes %j so it reads as itself (%s)', (text) => {
    const escaped = escapeTypstText(text);
    // Every character Typst gives meaning to is preceded by a backslash, and nothing else is.
    expect(escaped.replace(/\\(.)/gu, '$1')).toBe(text);
    expect(/(^|[^\\])[#$*_`@<>[\]~]/u.test(escaped)).toBe(false);
  });

  it('escapes a list or heading marker only where it leads a line', () => {
    expect(escapeTypstText('- one\nand a - in the middle')).toBe('\\- one\nand a - in the middle');
  });
});

describe('refuseNetworkImports', () => {
  // The three spellings the audit drove past the old regex, and the one it caught.
  it.each([
    ['#import "@preview/cetz:0.2.2": *', 'the literal package spec'],
    ['#import "\\u{40}preview/cetz:0.2.2": *', 'the same spec, escaped'],
    ['#import "@pre" + "view/cetz:0.2.2": *', 'the same spec, concatenated'],
    ['#import "@wraudit/thing:0.1.0": *', 'a third namespace, resolved off local disk'],
    ['#include "/etc/passwd"', 'a file'],
    ['#{ import "@preview/cetz:0.2.2": * }', 'an import written in code mode'],
  ])('refuses %j (%s)', (source) => {
    expect(refuseNetworkImports(source)).toContain('refused here');
  });

  it.each([
    ['#import calc: *', 'a module value reaches neither the network nor the disk'],
    ['We import "raw" logs from the cluster.', 'the word in a sentence is a word'],
    ['```\n#import "@preview/cetz:0.2.2": *\n```', 'a raw block is an example of one, not one'],
    ['// #import "@preview/cetz:0.2.2": *', 'a comment is not executed'],
    ['= Method\n\nTwo schedules, *massed* and spaced.', 'ordinary prose'],
  ])('allows %j (%s)', (source) => {
    expect(refuseNetworkImports(source)).toBeNull();
  });
});

describe('typstOpenDepth', () => {
  it.each([
    ['#figure(\n  image("/img/x"),\n\n  caption: [A caption],', 1],
    ['#figure(\n  image("/img/x"),\n\n  caption: [A caption],\n)', 0],
    ['#table(\n  columns: 2,', 1],
    ['#{ let x = 1', 1],
    ['A sentence with "an ( inside a string" in it.', 0],
    ['A sentence with `an ( inside raw` in it.', 0],
    ['#claim[a] and #claim[b]', 0],
  ])('reads %j as %i open', (source, depth) => {
    expect(typstOpenDepth(source)).toBe(depth);
  });
});

describe('excerptTypst', () => {
  it('is one block carrying the annotation link, whatever the quoted document says', () => {
    const typst = excerptTypst({
      annotationId: ANNOTATION,
      selectedText: 'Recall is ~50% stronger\n\nwhen review is spread out.',
      sourceTitle: 'Spacing effects',
    });
    expect(typst).toBe(
      `#quote(block: true, attribution: link("annotation://${ANNOTATION}")[Spacing effects])` +
        '[Recall is \\~50% stronger\nwhen review is spread out.]',
    );
    // One block: `parseBlocks` splits on blank lines and half an attribution is not a citation.
    expect(typst).not.toContain('\n\n');
  });
});

describe('figures', () => {
  it('round-trips a width without losing the alt text it was given', () => {
    const src = `#image("/img/${FILE}", alt: "A figure")`;
    expect(parseTypstImage(src)).toEqual({ fileId: FILE, alt: 'A figure', width: null });
    const wide = withTypstImageWidth(src, 240);
    expect(parseTypstImage(wide)).toEqual({ fileId: FILE, alt: 'A figure', width: 240 });
    expect(withTypstImageWidth(wide, null)).toBe(src);
  });

  it('is not a figure when it points outside the mounted pictures', () => {
    expect(parseTypstImage('#image("/etc/passwd")')).toBeNull();
  });
});

describe('typstSections', () => {
  it('lists the shallowest headings and believes nothing inside a fence', () => {
    expect(typstSections('= One\n\n== Deeper\n\n```\n= Not a heading\n```\n\n= Two')).toEqual([
      { heading: 'One', depth: 1 },
      { heading: 'Two', depth: 1 },
    ]);
  });
});

describe('typstPrelude', () => {
  it('puts the global header first so the local one can build on it and shadow it', () => {
    expect(typstPrelude({ global: '#let claim(b) = [C: #b]\n', local: '#let loud(b) = claim(b)' }))
      .toBe('#let claim(b) = [C: #b]\n\n#let loud(b) = claim(b)\n\n');
  });

  it('is nothing at all when neither header has been written', () => {
    expect(typstPrelude({ global: '', local: '  \n' })).toBe('');
  });
});

describe('the rest', () => {
  it('quotes a string that has quotes in it', () => {
    expect(typstString('Notes "draft"\\2')).toBe('"Notes \\"draft\\"\\\\2"');
  });

  it('opens a blank page on the template, spelled with `=`', () => {
    expect(blankNotebookTypst(['What I want to know', 'Method'])).toBe(
      '= What I want to know\n\n= Method\n',
    );
  });
});
