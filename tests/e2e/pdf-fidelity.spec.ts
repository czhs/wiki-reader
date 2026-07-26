/**
 * A PDF must render as the PDF.
 *
 * PDF.js embeds neither the standard-14 font programs nor the CID character maps. Given
 * neither, it does not fail — it substitutes, and a substituted font has different metrics,
 * so lines break in different places and the page is quietly not the page any more. 25 of
 * the 71 papers in a real Zotero library took that path while the whole suite was green,
 * because every existing assertion is about text being *present*.
 *
 * `sample-paper.pdf` cannot catch this: it is synthetic and embeds what it uses. So this
 * spec builds the failing case directly — a PDF that references Helvetica without embedding
 * it, which is the single commonest shape in the wild.
 */
import { test, expect } from './support/app.js';
import { launchApp } from './support/app.js';
import { writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A one-page PDF whose only font is non-embedded Helvetica.
 *
 * Written by hand rather than with a library so the omission is the point and is visible:
 * the font object has no `FontFile`, so the viewer must supply the program itself.
 */
function helveticaPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    // No FontDescriptor, no FontFile: the standard-14 case.
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 24 Tf 20 60 Td (Handgloves) Tj ET';
  objects.push(`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('[UX04] the bundle serves the font and cmap data PDF.js needs', async ({ window }) => {
  // Same-origin and reachable under the renderer's CSP, or PDF.js silently falls back.
  const probe = await window.evaluate(async () => {
    const fetchOne = async (path: string) => {
      try {
        const response = await fetch(new URL(path, document.baseURI).href);
        return { path, ok: response.ok, status: response.status };
      } catch (error) {
        return { path, ok: false, status: String(error) };
      }
    };
    return Promise.all([
      // The Helvetica substitute PDF.js reaches for, and a CJK character map.
      fetchOne('standard_fonts/LiberationSans-Regular.ttf'),
      fetchOne('standard_fonts/FoxitSerif.pfb'),
      fetchOne('cmaps/UniJIS-UCS2-H.bcmap'),
    ]);
  });
  for (const result of probe) {
    expect(result.ok, `${result.path} was not served: ${String(result.status)}`).toBe(true);
  }
});

/** Every PDF attachment the workspace materialised, so its bytes can be replaced. */
function pdfAttachmentPaths(zoteroDataDir: string): string[] {
  const out: string[] = [];
  const storage = join(zoteroDataDir, 'storage');
  for (const key of readdirSync(storage)) {
    const dir = join(storage, key);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name.toLowerCase().endsWith('.pdf')) out.push(join(dir, name));
    }
  }
  return out;
}

test('[UX05] a PDF using a non-embedded standard font renders with real glyphs', async ({
  workspace,
}) => {
  // The bytes behind the imported attachment are replaced, so the document opens through the
  // ordinary library → `rrfile://` → `loadPdf` path. Nothing test-only is added to the app.
  for (const path of pdfAttachmentPaths(workspace.zoteroDataDir)) {
    writeFileSync(path, helveticaPdf());
  }

  const { app, window } = await launchApp(workspace);

  // PDF.js reports a missing font *from the worker*, which `page.on('console')` never sees —
  // an earlier version of this test asserted on console output and passed just as happily
  // with the font URL pointed at a directory that does not exist. These two signals are the
  // ones that actually move: the fetch the reader makes, and whether a font program came
  // back and was registered.
  const fontResponses: { url: string; status: number }[] = [];
  window.on('response', (response) => {
    if (/\/standard_fonts\//.test(response.url())) {
      fontResponses.push({ url: response.url(), status: response.status() });
    }
  });

  try {
    await window.locator(`[data-testid="library-item-${workspace.pdfDocuments[0]!.id}"]`).click();
    await window.waitForSelector('[data-testid="pdf-page-0"][data-rendered="true"]', {
      timeout: 60_000,
    });
    await window.waitForTimeout(2500);

    expect(
      fontResponses.length,
      'the reader never asked for standard font data, so it drew Helvetica with whatever was lying around',
    ).toBeGreaterThan(0);
    expect(
      fontResponses.filter((r) => r.status !== 200),
      `the standard font data was requested but not served: ${JSON.stringify(fontResponses)}`,
    ).toEqual([]);

    // A font program that actually loaded is registered as a FontFace on the document;
    // when PDF.js falls back it renders through canvas with none registered at all.
    const registered = await window.evaluate(() => [...document.fonts].map((f) => f.family));
    expect(
      registered.length,
      'no font program was registered, so the glyphs on the page are substitutes',
    ).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
