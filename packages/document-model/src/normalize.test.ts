import { describe, expect, it } from 'vitest';
import {
  NORMALIZATION_VERSION,
  extractHtmlText,
  joinPdfTextItems,
  normalizeText,
  normalizeTextPreservingParagraphs,
} from './normalize.js';

describe('normalizeText', () => {
  it('[T05] collapses every whitespace variant to a single space', () => {
    expect(normalizeText('a   b\tc\r\nd')).toBe('a b c d');
  });

  it('[T05] strips zero-width and soft-hyphen characters', () => {
    expect(normalizeText('hy­phen​ated﻿')).toBe('hyphenated');
  });

  it('[T05] folds curly quotes, dashes and ellipses to ASCII', () => {
    expect(normalizeText('“quoted” — it’s here…')).toBe(
      '"quoted" - it\'s here...',
    );
  });

  it('[T05] applies NFC composition so decomposed input matches composed input', () => {
    const decomposed = 'étude';
    const composed = 'étude';
    expect(normalizeText(decomposed)).toBe(normalizeText(composed));
  });

  it('[T05] is idempotent', () => {
    const messy = '  “A—B”    c­d\r\n\r\n e ';
    const once = normalizeText(messy);
    expect(normalizeText(once)).toBe(once);
  });

  it('[T05] trims leading and trailing whitespace', () => {
    expect(normalizeText('   padded   ')).toBe('padded');
  });

  it('[T05] produces identical output for the same text extracted two ways', () => {
    // The same sentence as PDF.js might emit it vs. as the DOM would.
    const fromPdf = 'The quick brown\nfox  jumps';
    const fromDom = 'The quick brown fox jumps';
    expect(normalizeText(fromPdf)).toBe(normalizeText(fromDom));
  });

  it('[T05] declares a normalization version so anchors can detect algorithm drift', () => {
    expect(NORMALIZATION_VERSION).toBeGreaterThan(0);
  });
});

describe('normalizeTextPreservingParagraphs', () => {
  it('[T05] keeps one newline between paragraphs and collapses the rest', () => {
    expect(normalizeTextPreservingParagraphs('one\n\n\ntwo   three')).toBe('one\ntwo three');
  });
});

describe('joinPdfTextItems', () => {
  it('[T05] repairs words hyphenated across a line break', () => {
    const items = [
      { str: 'hyphen-', hasEOL: true },
      { str: 'ation is annoying' },
    ];
    expect(normalizeText(joinPdfTextItems(items))).toBe('hyphenation is annoying');
  });

  it('[T05] leaves genuine hyphenated compounds intact', () => {
    const items = [{ str: 'well-known result' }];
    expect(normalizeText(joinPdfTextItems(items))).toBe('well-known result');
  });

  it('[T05] does not rejoin across a capitalised line start', () => {
    const items = [{ str: 'end-', hasEOL: true }, { str: 'Start' }];
    expect(joinPdfTextItems(items)).toBe('end-\nStart');
  });
});

describe('extractHtmlText', () => {
  it('[T05] extracts the prose of a saved page and drops its markup', () => {
    const html = `<!DOCTYPE html>
      <html><head><title>Ignored</title><style>p { color: red }</style></head>
      <body>
        <h1>Attention Is All You Need</h1>
        <p>The dominant sequence transduction models are based on
        complex recurrent networks.</p>
        <p>We propose the <b>Transformer</b>.</p>
      </body></html>`;

    expect(normalizeTextPreservingParagraphs(extractHtmlText(html))).toBe(
      'Attention Is All You Need\n' +
        'The dominant sequence transduction models are based on complex recurrent networks.\n' +
        'We propose the Transformer.',
    );
  });

  it('[T05] does not insert whitespace at an inline element boundary', () => {
    // A quote spanning a styled word is the common case for a highlight on a web page; a
    // space here would put every such anchor's offsets out by one and break the quote match.
    expect(normalizeText(extractHtmlText('<p>hyper<em>text</em>ual</p>'))).toBe('hypertextual');
    expect(normalizeText(extractHtmlText('<p>a <a href="#x">link</a> here</p>'))).toBe(
      'a link here',
    );
  });

  it('[T05] separates block elements so two paragraphs never fuse into one word', () => {
    expect(normalizeText(extractHtmlText('<p>one</p><p>two</p>'))).toBe('one two');
    expect(normalizeText(extractHtmlText('<li>one</li><li>two</li>'))).toBe('one two');
    expect(normalizeText(extractHtmlText('first<br>second'))).toBe('first second');
  });

  it('[T05] drops script and style content rather than reading it as prose', () => {
    const html =
      '<p>before</p><script>var evil = "steal";</script><style>body{}</style><p>after</p>';
    const text = normalizeText(extractHtmlText(html));
    expect(text).toBe('before after');
    expect(text).not.toContain('steal');
  });

  it('[T05] does not mistake a comparison inside a script for markup', () => {
    // `<b` here opens no element. A scanner that handed this to a tag matcher would resume
    // reading prose in the middle of the script body.
    const html = '<p>before</p><script>if (a<b && c>d) { document.title = "x"; }</script><p>after</p>';
    expect(normalizeText(extractHtmlText(html))).toBe('before after');
  });

  it('[T05] is not fooled by a `>` inside a quoted attribute value', () => {
    // The regex `/<[^>]*>/g` stops at the quoted bracket and emits `b">visible` as text.
    expect(normalizeText(extractHtmlText('<a title="a > b">visible</a>'))).toBe('visible');
  });

  it('[T05] decodes character references, including numeric and hex forms', () => {
    expect(normalizeText(extractHtmlText('<p>caf&eacute;&nbsp;&amp; bar</p>'))).toBe(
      'caf&eacute; & bar',
    );
    expect(normalizeText(extractHtmlText('<p>&#233;t&#xe9;</p>'))).toBe('été');
    expect(normalizeText(extractHtmlText('<p>&mdash;&hellip;</p>'))).toBe('-...');
  });

  it('[T05] decodes escaped markup as text instead of stripping it', () => {
    // A page about HTML writes `&lt;script&gt;` in its prose. Decoding before tag removal
    // would delete it; the reader can see it, so an anchor must be able to address it.
    expect(normalizeText(extractHtmlText('<p>use &lt;script&gt; carefully</p>'))).toBe(
      'use <script> carefully',
    );
  });

  it('[T05] treats a bare `<` that starts no tag as the text it is', () => {
    expect(normalizeText(extractHtmlText('<p>if a < b then</p>'))).toBe('if a < b then');
  });

  it('[T05] drops a truncated tag rather than spilling it into the text', () => {
    expect(normalizeText(extractHtmlText('<p>kept</p><div class="unclosed'))).toBe('kept');
    expect(normalizeText(extractHtmlText('<p>kept</p><!-- unterminated'))).toBe('kept');
    expect(normalizeText(extractHtmlText('<p>kept</p><script>never closed'))).toBe('kept');
  });

  it('[T05] normalizes the same sentence identically from HTML and from a PDF text layer', () => {
    // The invariant that makes an anchor portable across representations: the same prose,
    // extracted two ways, must produce the same normalized string and so the same offsets.
    const fromHtml = extractHtmlText(
      '<p>The&nbsp;quick <b>brown</b>\n   fox&#8212;jumps.</p>',
    );
    const fromPdf = joinPdfTextItems([
      { str: 'The quick brown', hasEOL: true },
      { str: 'fox—jumps.' },
    ]);
    expect(normalizeText(fromHtml)).toBe(normalizeText(fromPdf));
    expect(normalizeText(fromHtml)).toBe('The quick brown fox-jumps.');
  });

  it('[T05] folds a hard-wrapped paragraph but keeps the line structure of a code block', () => {
    // Outside `<pre>` a source newline is collapsible whitespace, so an author's 80-column
    // wrapping must not become paragraph breaks in the extracted text.
    expect(normalizeTextPreservingParagraphs(extractHtmlText('<p>one\n  two\n  three</p>'))).toBe(
      'one two three',
    );
    expect(
      normalizeTextPreservingParagraphs(extractHtmlText('<pre>def f():\n    return 1</pre>')),
    ).toBe('def f():\nreturn 1');
  });

  it('[T05] leaves an empty document as an empty string, not a crash', () => {
    expect(extractHtmlText('')).toBe('');
    expect(normalizeText(extractHtmlText('<html><body></body></html>'))).toBe('');
  });
});
