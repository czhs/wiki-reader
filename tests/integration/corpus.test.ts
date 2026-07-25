/**
 * The markdown corpus, end to end through the real importer, a real SQLite file and real
 * markdown on disk.
 *
 * Nothing here is stubbed: the files are written to a temporary directory, walked, parsed by
 * remark, stored, indexed into FTS5, and linked. That is what makes W07's claim — re-indexing
 * replaces derived links and preserves manual ones — a fact about the shipping code path.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WikiReaderDatabase } from '@wr/database';
import {
  MarkdownCorpusImporter,
  WIKILINK_GENERATOR,
  WIKILINK_LINK_TYPE,
} from '../../apps/desktop/src/main/corpus.js';
import { allowedRoots } from '../../apps/desktop/src/main/paths.js';

let dir: string;
let corpusRoot: string;
let db: WikiReaderDatabase;

function write(name: string, body: string): string {
  const path = join(corpusRoot, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return path;
}

function importer(): MarkdownCorpusImporter {
  return new MarkdownCorpusImporter(db, {
    root: corpusRoot,
    allowed: allowedRoots(corpusRoot),
  });
}

/** The document a corpus file became, by page name. */
function documentFor(slug: string): { id: string; title: string } {
  const document = db.documents.getBySlug(slug);
  if (document === null) throw new Error(`no document for slug ${slug}`);
  return { id: document.id, title: document.title };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wr-corpus-')));
  corpusRoot = join(dir, 'corpus');
  mkdirSync(corpusRoot, { recursive: true });
  db = openDatabase({ file: join(dir, 'wiki-reader.db') }).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('markdown corpus import', () => {
  it('imports a folder of markdown as documents addressed by page name', async () => {
    write('Field Station.md', '# Field Station\n\nA place to work from.\n');
    write('notes/Ground Truth.md', '# Ground Truth\n\nWhat we compare against.\n');

    const summary = await importer().import();

    expect(summary.filesSeen).toBe(2);
    expect(summary.documentsCreated).toBe(2);
    expect(summary.warnings).toEqual([]);
    expect(documentFor('field-station').title).toBe('Field Station');
    expect(documentFor('ground-truth').title).toBe('Ground Truth');
  });

  it('is idempotent: a second run over unchanged bytes creates nothing', async () => {
    write('Field Station.md', '# Field Station\n\nA place to work from.\n');
    await importer().import();

    const second = await importer().import();
    expect(second.documentsCreated).toBe(0);
    expect(second.documentsUnchanged).toBe(1);
    expect(db.documents.count()).toBe(1);
  });

  it('indexes markdown sections so a search finds the section it came from', async () => {
    write(
      'Field Station.md',
      '# Field Station\n\nIntro.\n\n## Ablations\n\nRemoving the retriever hurts recall.\n',
    );
    await importer().import();

    const { id } = documentFor('field-station');
    const chunks = db.chunks.listForDocument(id);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((chunk) => chunk.kind === 'markdown-section')).toBe(true);
    expect(chunks.map((chunk) => chunk.sectionPath)).toContain('field-station/ablations');
  });

  it('makes a wikilink a typed edge between the two documents', async () => {
    write('Field Station.md', '# Field Station\n\nSee [[Ground Truth]].\n');
    write('Ground Truth.md', '# Ground Truth\n\nThe boundary.\n');

    await importer().import();

    const source = documentFor('field-station');
    const target = documentFor('ground-truth');
    const links = db.links.findReferences({ entityType: 'document', entityId: source.id });
    const wikilink = links.find((link) => link.type === WIKILINK_LINK_TYPE);
    expect(wikilink).toBeDefined();
    expect(wikilink?.targetId).toBe(target.id);
    expect(wikilink?.origin).toBe('derived');
    expect(wikilink?.generator).toBe(WIKILINK_GENERATOR);
  });

  it('[W08] records a [[slug]] with no page behind it as a wanted page', async () => {
    write('Field Station.md', '# Field Station\n\nStill to write: [[Ground Truth]].\n');
    await importer().import();

    const wanted = db.wantedPages.list();
    expect(wanted).toHaveLength(1);
    expect(wanted[0]?.slug).toBe('ground-truth');
    expect(wanted[0]?.referencedBy).toEqual([documentFor('field-station').id]);

    // Writing the page is all it takes: nothing rewrites the link, and the next import
    // resolves it.
    write('Ground Truth.md', '# Ground Truth\n\nWritten at last.\n');
    await importer().import({ force: true });
    expect(db.wantedPages.list()).toEqual([]);
  });
});

describe('re-indexing', () => {
  it('[W07] replaces the derived links of a re-indexed document', async () => {
    write('Field Station.md', '# Field Station\n\nSee [[Ground Truth]].\n');
    write('Ground Truth.md', '# Ground Truth\n\nThe boundary.\n');
    write('Corpus.md', '# Corpus\n\nThe pile of sources.\n');
    await importer().import();

    const source = documentFor('field-station');
    const groundTruth = documentFor('ground-truth');
    const corpus = documentFor('corpus');

    const derivedTargets = (): string[] =>
      db.links
        .findReferences({ entityType: 'document', entityId: source.id, direction: 'outgoing' })
        .filter((link) => link.generator === WIKILINK_GENERATOR)
        .map((link) => link.targetId)
        .sort();

    expect(derivedTargets()).toEqual([groundTruth.id]);

    // The author changes their mind: the link now points somewhere else.
    write('Field Station.md', '# Field Station\n\nSee [[Corpus]] instead.\n');
    await importer().import();

    expect(derivedTargets()).toEqual([corpus.id]);
  });

  it('[W07] preserves a manually created link across a re-index', async () => {
    write('Field Station.md', '# Field Station\n\nSee [[Ground Truth]].\n');
    write('Ground Truth.md', '# Ground Truth\n\nThe boundary.\n');
    write('Corpus.md', '# Corpus\n\nThe pile of sources.\n');
    await importer().import();

    const source = documentFor('field-station');
    const corpus = documentFor('corpus');

    // A link the reader made by hand, from the same document, of a different type.
    const manual = db.links.create({
      type: 'related-to',
      sourceType: 'document',
      sourceId: source.id,
      targetType: 'document',
      targetId: corpus.id,
      label: 'read together',
      origin: 'manual',
    });

    // A hand-made link of the *same* type as the generator's is the harder case: deleting by
    // (source, type) rather than by (source, origin, generator) would take it with it.
    const manualSameType = db.links.create({
      type: WIKILINK_LINK_TYPE,
      sourceType: 'document',
      sourceId: source.id,
      targetType: 'document',
      targetId: corpus.id,
      label: 'hand-made',
      origin: 'manual',
    });

    write('Field Station.md', '# Field Station\n\nNo links any more.\n');
    const summary = await importer().import();
    expect(summary.linksCreated).toBe(0);

    const after = db.links.findReferences({
      entityType: 'document',
      entityId: source.id,
      direction: 'outgoing',
    });
    expect(after.map((link) => link.id)).toContain(manual.id);
    expect(after.map((link) => link.id)).toContain(manualSameType.id);
    expect(after.filter((link) => link.generator === WIKILINK_GENERATOR)).toEqual([]);
  });

  it('[W07] leaves another generator’s derived links alone', async () => {
    write('Field Station.md', '# Field Station\n\nSee [[Ground Truth]].\n');
    write('Ground Truth.md', '# Ground Truth\n\nThe boundary.\n');
    await importer().import();

    const source = documentFor('field-station');
    const target = documentFor('ground-truth');
    const otherGenerator = db.links.create({
      type: 'document-cites-document',
      sourceType: 'document',
      sourceId: source.id,
      targetType: 'document',
      targetId: target.id,
      origin: 'derived',
      generator: 'citation-parser',
    });

    write('Field Station.md', '# Field Station\n\nNothing here.\n');
    await importer().import();

    expect(db.links.getById(otherGenerator.id)).not.toBeNull();
  });
});
