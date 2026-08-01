/**
 * Files added straight from disk (criterion N07, and B02 after it).
 *
 * The criterion says *without leaving the researcher's disk*, and the assertions are shaped
 * to fail against the implementation that ignores that: the library row must name the file
 * where it already is, and no second copy may appear anywhere the application owns.
 *
 * The other half is the price of not copying. `rrfile://` refuses any path outside the
 * allowed roots, so a file in an inbox folder is unreadable until it is *admitted* — and the
 * test that matters is the one asserting the admission is one **file** and not one folder. A
 * drop that quietly widened the allow-list to `~/Downloads` would pass every other assertion
 * here while handing away everything sitting beside the paper.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcTopic, IpcTopicPayload } from '@wr/shared-types';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { receiveDrop } from '../../apps/desktop/src/main/handlers.js';
import { AddFileError } from '../../apps/desktop/src/main/local-files.js';
import { resolveAllowedPath } from '../../apps/desktop/src/main/paths.js';

interface Published {
  readonly topic: string;
  readonly payload: unknown;
}

/**
 * Its own harness rather than `IntegrationWorkspace`, and deliberately.
 *
 * What this file is about is where things are on disk: the database sits in a subdirectory so
 * that "outside every root" means something, the temp directory is resolved through its
 * symlinks because macOS hands out `/var/folders/…` and every stored path is resolved first,
 * and there is an inbox the app was never told about. The shared harness owns exactly those
 * two paths, so bending it to this would make it configurable for one caller.
 */
class Workspace {
  readonly dir: string;
  readonly databasePath: string;
  readonly inbox: string;
  readonly published: Published[] = [];
  private current: AppServices;

  constructor() {
    // `realpathSync`, because macOS hands out `/var/folders/…` symlinks for the temp
    // directory and every path the library stores is resolved through symlinks first — the
    // same relocation the E2E workspace makes for the same reason.
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), 'wr-local-files-')));
    this.databasePath = join(this.dir, 'library', 'wiki-reader.db');
    mkdirSync(join(this.dir, 'library'), { recursive: true });
    // Deliberately outside every root the app is configured with: this is where the
    // researcher keeps their own files, and the app has no business reading it wholesale.
    this.inbox = join(this.dir, 'inbox');
    mkdirSync(this.inbox, { recursive: true });
    this.current = this.open();
  }

  private open(): AppServices {
    return createTestServices({
      databasePath: this.databasePath,
      zoteroDataDir: join(this.dir, 'zotero'),
      markdownRoot: join(this.dir, 'corpus'),
      publish: <K extends IpcTopic>(topic: K, payload: IpcTopicPayload<K>) => {
        this.published.push({ topic, payload });
      },
    });
  }

  get services(): AppServices {
    return this.current;
  }

  restart(): void {
    this.current.close();
    this.current = this.open();
  }

  /** A file in the inbox, with real bytes. */
  file(name: string, contents = 'a paper about induction heads'): string {
    const path = join(this.inbox, name);
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  dispose(): void {
    this.current.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(() => {
  workspace.dispose();
});

/** Every file under `dir`, recursively — so "was it copied?" has an answer. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

describe('a file added from disk', () => {
  it('[N07] becomes a document that names the file where it already is', async () => {
    const path = workspace.file('induction-heads.pdf');
    const before = statSync(path);

    const { document, created } = await workspace.services.localFiles.add(path);

    expect(created).toBe(true);
    expect(document.title).toBe('induction-heads');
    expect(document.docType).toBe('pdf');
    const file = workspace.services.db.files.primaryForDocument(document.id);
    expect(file?.path).toBe(path);
    // Untouched: same inode, same size. The library points at the researcher's file rather
    // than at a copy of it.
    const after = statSync(path);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    // And nothing was written into the application's own directory but the database.
    const copies = filesUnder(join(workspace.dir, 'library')).filter((candidate) =>
      candidate.endsWith('induction-heads.pdf'),
    );
    expect(copies).toEqual([]);
  });

  it('[N07] admits that one file and not the folder it came from', async () => {
    const path = workspace.file('induction-heads.pdf');
    const sibling = workspace.file('tax-return.pdf', 'not the app’s business');
    const roots = workspace.services.allowed;

    // Before: neither is readable, because the inbox is nobody's root.
    expect((await resolveAllowedPath(path, roots)).ok).toBe(false);

    await workspace.services.localFiles.add(path);

    expect((await resolveAllowedPath(path, roots)).ok).toBe(true);
    // The assertion the whole design turns on. Admitting the containing folder would have
    // been one line shorter and would have handed over everything beside the paper.
    const refused = await resolveAllowedPath(sibling, roots);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('outside-roots');
  });

  it('[N07] is still readable after a restart, and its neighbours still are not', async () => {
    const path = workspace.file('induction-heads.pdf');
    const sibling = workspace.file('tax-return.pdf', 'not the app’s business');
    await workspace.services.localFiles.add(path);

    workspace.restart();

    // A remembered admission that was not re-applied at startup would make this a library row
    // whose bytes the app now refuses — the stranded-corpus failure, from the other side.
    expect((await resolveAllowedPath(path, workspace.services.allowed)).ok).toBe(true);
    expect((await resolveAllowedPath(sibling, workspace.services.allowed)).ok).toBe(false);
  });

  it('[N07] adds the same file twice as one document', async () => {
    const path = workspace.file('induction-heads.pdf');

    const first = await workspace.services.localFiles.add(path);
    const second = await workspace.services.localFiles.add(path);

    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(workspace.services.db.documents.list({ source: 'local' }).total).toBe(1);
  });

  it('[N07] refuses a folder, and a path that is not there', async () => {
    await expect(workspace.services.localFiles.add(workspace.inbox)).rejects.toBeInstanceOf(
      AddFileError,
    );
    await expect(
      workspace.services.localFiles.add(join(workspace.inbox, 'nothing.pdf')),
    ).rejects.toBeInstanceOf(AddFileError);
    // Nothing was admitted on the way to refusing, so a refusal cannot widen the allow-list.
    expect(workspace.services.localFiles.remembered()).toEqual([]);
  });
});

describe('a drop on a question’s board', () => {
  const ask = async (): Promise<string> => {
    const question = workspace.services.db.questions.create({ title: 'Which papers show it?' });
    return question.id;
  };

  it('[N07] puts a card on the board for each dropped file', async () => {
    const questionId = await ask();
    const one = workspace.file('induction-heads.pdf');
    const two = workspace.file('copying-circuit.pdf');

    const { added } = await receiveDrop(workspace.services, { questionId, paths: [one, two] });

    expect(added).toBe(2);
    const cards = workspace.services.db.links.findReferences({
      entityType: 'question',
      entityId: questionId,
      direction: 'outgoing',
    });
    expect(cards.map((link) => link.type)).toEqual([
      'question-references-document',
      'question-references-document',
    ]);
    // The card arrives unplaced: a file dropped at a point on the screen has still not been
    // *arranged*, and the board records only what a hand moved.
    expect(workspace.services.db.board.positionsForQuestion(questionId).size).toBe(0);
    expect(
      workspace.published.filter((event) => event.topic === 'notebook:changed'),
    ).toHaveLength(1);
  });

  it('[N07] drops the same file twice without growing a second card', async () => {
    const questionId = await ask();
    const path = workspace.file('induction-heads.pdf');

    await receiveDrop(workspace.services, { questionId, paths: [path] });
    const second = await receiveDrop(workspace.services, { questionId, paths: [path] });

    expect(second.added).toBe(0);
    expect(
      workspace.services.db.links.findReferences({
        entityType: 'question',
        entityId: questionId,
        direction: 'outgoing',
      }),
    ).toHaveLength(1);
  });

  it('[N07] lands the good files even when one of them is not a file', async () => {
    const questionId = await ask();
    const good = workspace.file('induction-heads.pdf');

    const { added } = await receiveDrop(workspace.services, {
      questionId,
      paths: [workspace.inbox, good, join(workspace.inbox, 'gone.pdf')],
    });

    expect(added).toBe(1);
    // And the refusals admitted nothing: only the file that became a card is readable.
    expect(workspace.services.localFiles.remembered()).toEqual([good]);
  });

  it('[N07] refuses a drop on a question that does not exist', async () => {
    const path = workspace.file('induction-heads.pdf');

    await expect(
      receiveDrop(workspace.services, {
        questionId: 'qst_00000000000000000000000000',
        paths: [path],
      }),
    ).rejects.toThrow();
    // Nothing was added on the way to refusing.
    expect(workspace.services.localFiles.remembered()).toEqual([]);
    expect(workspace.services.db.documents.list({ source: 'local' }).total).toBe(0);
  });
});
