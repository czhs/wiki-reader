/**
 * Generate the deterministic PDF fixture used by the extraction and indexing tests.
 *
 * The fixture is a real PDF — a real `%PDF` header, real page tree, real content streams
 * with `Tj` operators — so PDF.js parses it through exactly the same path it uses for a
 * paper out of Zotero storage. Inventing extracted text instead would let the extraction
 * step break without a single test noticing.
 *
 * Deterministic on purpose: no timestamps, no ObjectIDs, no compression. Regenerating the
 * fixture on another machine must produce a byte-identical file, otherwise the checked-in
 * fixture would churn in every diff.
 *
 *   node scripts/make_pdf_fixture.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tests', 'fixtures', 'sample-paper.pdf');

/**
 * Page text, as lines. Terms are chosen so the search tests can assert on discriminating
 * matches: a term that appears on exactly one page proves a hit resolved to the right page.
 */
const PAGES = [
  [
    'Attention Mechanisms in Sequence Models',
    '',
    'Abstract',
    'We introduce a sequence transduction architecture that dispenses with',
    'recurrence entirely and relies exclusively on a scaled dot-product',
    'attention operator. On the WMT 2014 English-to-German benchmark the',
    'model reaches 28.4 BLEU while training in a fraction of the time',
    'required by the recurrent baselines it replaces.',
    '',
    'The central claim of this work is that alignment quality does not',
    'depend on sequential computation. Positional information enters the',
    'model through fixed sinusoidal encodings rather than through the',
    'order in which tokens are processed.',
  ],
  [
    'Method',
    '',
    'Each encoder layer applies multi-head attention followed by a',
    'position-wise feedforward network. Residual connections wrap both',
    'sublayers and layer normalisation is applied to the sum.',
    '',
    'The scaled dot-product operator divides the logits by the square root',
    'of the key dimension. Without this rescaling the softmax saturates for',
    'large key dimensions and the resulting gradients become vanishingly',
    'small, which is the specific failure this normalisation prevents.',
    '',
    'We train with the Adam optimiser and a warmup schedule that increases',
    'the learning rate linearly for the first four thousand steps, then',
    'decays it proportionally to the inverse square root of the step',
    'number. Label smoothing of 0.1 is applied throughout.',
  ],
  buildLongPage(),
];

/**
 * A page comfortably longer than the default 2000-character chunk limit, so the fixture
 * exercises intra-page splitting rather than only the 1:1 page-to-chunk case.
 */
function buildLongPage() {
  const lines = ['Results and Ablations', ''];
  const observations = [
    'Removing the residual connection degrades convergence sharply.',
    'Halving the number of attention heads costs 0.9 BLEU on the test set.',
    'Sharing the embedding and output projection saves many parameters.',
    'Dropout on the attention weights is the strongest single regulariser.',
    'Increasing model depth beyond twelve layers yields no further gain.',
    'Beam search with a width of four outperforms greedy decoding.',
  ];
  // Four groups keeps every line inside the MediaBox while still pushing the page well past
  // the 2000-character chunk limit. Text drawn outside the page box is not extractable.
  for (let round = 1; round <= 4; round += 1) {
    lines.push(`Ablation group ${round}.`);
    for (const observation of observations) {
      lines.push(observation);
      lines.push('We repeat this measurement across three independent seeds.');
    }
    lines.push('');
  }
  // A term that occurs on no other page, so a hit on it is unambiguous.
  lines.push('The complete hyperparameter sweep is reproducible from the seed table.');
  return lines;
}

/** Escape the three characters that are special inside a PDF literal string. */
function escapePdfString(value) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(lines) {
  const body = lines
    .map((line) => (line === '' ? 'T*' : `(${escapePdfString(line)}) Tj T*`))
    .join('\n');
  return `BT\n/F1 9 Tf\n12 TL\n56 760 Td\n${body}\nET\n`;
}

function build() {
  const pageCount = PAGES.length;
  // 1 = Catalog, 2 = Pages, then (Page, Contents) per page, then the shared Font.
  const pageObjNum = (index) => 3 + index * 2;
  const contentObjNum = (index) => 4 + index * 2;
  const fontObjNum = 3 + pageCount * 2;

  const objects = new Map();

  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = PAGES.map((_, index) => `${pageObjNum(index)} 0 R`).join(' ');
  objects.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);

  PAGES.forEach((lines, index) => {
    objects.set(
      pageObjNum(index),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> ` +
        `/Contents ${contentObjNum(index)} 0 R >>`,
    );
    const stream = contentStream(lines);
    objects.set(
      contentObjNum(index),
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    );
  });

  objects.set(fontObjNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  // Serialise, recording each object's byte offset for the cross-reference table.
  const maxObj = fontObjNum;
  const offsets = new Array(maxObj + 1).fill(0);
  let pdf = '%PDF-1.4\n';

  for (let num = 1; num <= maxObj; num += 1) {
    const body = objects.get(num);
    if (body === undefined) throw new Error(`missing object ${num}`);
    offsets[num] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxObj; num += 1) {
    pdf += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

mkdirSync(dirname(OUT), { recursive: true });
const bytes = build();
writeFileSync(OUT, bytes);
console.log(`wrote ${OUT} (${bytes.length} bytes, ${PAGES.length} pages)`);
