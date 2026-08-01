/**
 * What the librarian is handed to read (criterion A11).
 *
 * `A11` guards the load-bearing decision of the milestone against the reflex fix. When the
 * corpus outgrows the context the obvious move is to add retrieval, and it is the wrong one:
 * top-k chunks are precisely the input that cannot yield a connection, because the ranking
 * decided what was related before the model saw it.
 *
 * So there are two halves to assert, and both are here. The agent is handed **whole
 * documents** — every chunk, in order, nothing dropped and nothing summarised. And **nothing
 * in its path ranks or embeds**, which is checked against the source of the agent modules
 * themselves, because that is the form the regression would arrive in: someone adding an
 * import, not someone changing an assertion.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';
import { WikiView, isReadOnly } from '../../apps/desktop/src/main/agents/wiki-view.js';

const AGENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'desktop',
  'src',
  'main',
  'agents',
);

/** Long enough that any sane top-k or truncation would have to drop some of it. */
const PAGES = Array.from(
  { length: 40 },
  (_, index) =>
    `Page ${index + 1}. ` +
    `The residual stream carries feature number ${index * 7 + 3} at this depth. `.repeat(30),
);

describe('the wiki as the librarian reads it', () => {
  let dir: string;
  let services: AppServices;
  let view: WikiView;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wr-wiki-view-'));
    services = createTestServices({
      databasePath: join(dir, 'wiki-reader.db'),
      zoteroDataDir: join(dir, 'zotero'),
    });
    view = new WikiView({ db: services.db, root: join(dir, 'view'), logger: silentLogger });
  });

  afterEach(async () => {
    // The view seals itself read-only, and a read-only directory refuses to have entries
    // unlinked from it — so an ordinary `rm -rf` cannot clean this up.
    await view.remove();
    services.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const paperWithPages = (title: string): string => {
    const { db } = services;
    const document = db.documents.create({ title, docType: 'pdf', source: 'zotero' });
    const { revision } = db.revisions.createIfChanged({
      documentId: document.id,
      contentHash: `hash-${title}`,
    });
    let offset = 0;
    db.chunks.replaceForRevision(
      document.id,
      revision.id,
      PAGES.map((text, index) => {
        const charStart = offset;
        offset += text.length;
        return {
          chunkIndex: index,
          kind: 'pdf-page' as const,
          pageIndex: index,
          sectionPath: null,
          charStart,
          charEnd: offset,
          text,
        };
      }),
    );
    return document.id;
  };

  it('[A11] writes every chunk of a document, in order, with nothing dropped', async () => {
    const documentId = paperWithPages('Scaling monosemanticity');

    await view.materialise();
    const page = await readFile(join(view.root, 'documents', `${documentId}.md`), 'utf8');

    // Every page, not a selection of them. The first and last are named separately because a
    // truncation that keeps the head, or a tail-biased one, would still pass a spot check.
    for (const chunk of PAGES) expect(page).toContain(chunk);
    expect(page).toContain(PAGES[0] as string);
    expect(page).toContain(PAGES[PAGES.length - 1] as string);

    // And in the order they were extracted: a set of pages in the wrong order is a different
    // document from the one the researcher read.
    const positions = PAGES.map((chunk) => page.indexOf(chunk));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('[A11] takes no query, no limit and no relevance — there is nothing to rank with', async () => {
    paperWithPages('One');
    paperWithPages('Two');
    paperWithPages('Three');

    // The only way to ask for the wiki is to ask for all of it.
    const summary = await view.materialise();

    expect(summary.documents).toBe(3);
    expect(view.materialise).toHaveLength(0);
    const documents = await readdir(join(view.root, 'documents'));
    expect(documents).toHaveLength(3);
    expect(summary.characters).toBeGreaterThan(PAGES.join('').length * 3 - 1);
  });

  it('[A11] has no ranking, no embedding and no search anywhere in the agent path', async () => {
    const sources = await readdir(AGENTS_DIR);
    expect(sources.length).toBeGreaterThan(3);

    const banned = /embedding|embed\(|vectorStore|vector_store|cosine|topK|top_k|bm25|rerank/i;
    for (const file of sources) {
      const source = await readFile(join(AGENTS_DIR, file), 'utf8');
      // Prose about *not* doing retrieval is the whole point of these files, so only code is
      // examined: comment lines are stripped before the check.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(code, `${file} names a retrieval mechanism`).not.toMatch(banned);
      expect(code, `${file} imports the search package`).not.toContain('@wr/search');
    }
  });

  it('[A11] carries the questions, the journal and the notes, not only the papers', async () => {
    const { db } = services;
    const question = db.questions.create({ title: 'Does feature splitting bottom out?' });
    db.journal.write(question.id, '2026-07-20', 'Read two papers that disagree about width sweeps.');
    db.notes.create({ title: 'Width sweeps', contentJson: {}, contentText: 'Worth a closer look.' });

    await view.materialise();

    await expect(
      readFile(join(view.root, 'questions', `${question.id}.md`), 'utf8'),
    ).resolves.toContain('Does feature splitting bottom out?');
    // Filed under the notebook whose day it is: flat by date, two notebooks written in on
    // the same afternoon would overwrite each other and the librarian would read one of them.
    await expect(
      readFile(join(view.root, 'journal', question.id, '2026-07-20.md'), 'utf8'),
    ).resolves.toContain('width sweeps');
    await expect(readFile(join(view.root, 'README.md'), 'utf8')).resolves.toContain(
      'read-only to you',
    );
  });

  it('[A02] leaves the wiki read-only on disk, so a write fails below the tool layer', async () => {
    const documentId = paperWithPages('Sealed');
    await view.materialise();

    await expect(isReadOnly(join(view.root, 'documents', `${documentId}.md`))).resolves.toBe(true);
    await expect(isReadOnly(view.root)).resolves.toBe(true);

    // The kernel refuses, not a prompt. `--add-dir` would otherwise make this directory
    // writable to the agent, and a saved web page is hostile input.
    await expect(
      writeFile(join(view.root, 'documents', `${documentId}.md`), 'rewritten by the agent'),
    ).rejects.toThrow();
    await expect(writeFile(join(view.root, 'planted.md'), 'planted by the agent')).rejects.toThrow();

    // And it can still be rebuilt, which is what makes the seal safe to apply.
    await expect(view.materialise()).resolves.toMatchObject({ documents: 1 });
  });
});
