/**
 * Which Zotero collections an import covers, and where that choice is kept.
 *
 * Scoping already existed (`W12`) but only as an argument nobody supplied: the interface
 * imported the whole library every time, and a researcher whose Zotero holds fifteen years of
 * everything got fifteen years of everything. The missing halves were a way to *pick* and a
 * place to remember the picks, which is all this module is.
 *
 * Picks are stored as names rather than Zotero keys because the importer scopes by name, and
 * because a name is what the person recognises when the list is shown back to them. The cost
 * is that renaming a collection in Zotero loses the pick — visible in the picker, since it is
 * built from the live list — where a key would have followed it. That trade is deliberate:
 * matching the importer's existing unit is worth more than surviving a rename silently.
 */
import { z } from 'zod';
import type { WikiReaderDatabase } from '@wr/database';
import type { ZoteroCollection } from '@wr/zotero-adapter';

/** Settings key holding the remembered pick list. */
export const IMPORT_SCOPE_SETTING = 'zotero.importScope';

const StoredScopeSchema = z.object({ collections: z.array(z.string().min(1)) });

/** One line in the picker. */
export interface CollectionOption {
  readonly name: string;
  readonly label: string;
  readonly ambiguous: boolean;
}

/** The remembered picks. Empty means the whole library, which is also the default. */
export function readImportScope(db: WikiReaderDatabase): readonly string[] {
  const parsed = StoredScopeSchema.safeParse(db.settings.get(IMPORT_SCOPE_SETTING));
  return parsed.success ? parsed.data.collections : [];
}

/** Remember the picks, dropping blanks and repeats so the stored list is what it says. */
export function writeImportScope(
  db: WikiReaderDatabase,
  collections: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const name of collections) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === '' || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
  }
  db.settings.set(IMPORT_SCOPE_SETTING, { collections: cleaned });
  return cleaned;
}

/**
 * Turn Zotero's collection list into picker lines.
 *
 * The label is the breadcrumb, because "Drafts" under three different projects is three
 * different collections and a flat list of identical names is unpickable. `ambiguous` marks
 * the names the importer will refuse to scope by, so the picker can say why up front rather
 * than after a failed import.
 */
export function collectionOptions(collections: readonly ZoteroCollection[]): CollectionOption[] {
  const byKey = new Map(collections.map((collection) => [collection.data.key, collection]));

  const labelFor = (collection: ZoteroCollection): string => {
    const parts: string[] = [collection.data.name];
    const seen = new Set<string>([collection.data.key]);
    let parent = collection.data.parentCollection;
    // Bounded by `seen`: a cycle in the parent links would otherwise loop forever, and the
    // list arrives over the network from another process.
    while (typeof parent === 'string' && !seen.has(parent)) {
      const next = byKey.get(parent);
      if (next === undefined) break;
      seen.add(parent);
      parts.unshift(next.data.name);
      parent = next.data.parentCollection;
    }
    return parts.join(' / ');
  };

  const counts = new Map<string, number>();
  for (const collection of collections) {
    const key = collection.data.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return collections
    .map((collection) => ({
      name: collection.data.name,
      label: labelFor(collection),
      ambiguous: (counts.get(collection.data.name.trim().toLowerCase()) ?? 0) > 1,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The picker's fallback: the collections the last import mirrored into the library.
 *
 * Zotero serves its local API only while it is running, so a picker that could only be built
 * from a live connection would be empty exactly when someone opens the app to read. These
 * rows are the previous answer to the same question, which is a worse answer than the live
 * one and a much better one than none.
 */
export function collectionOptionsFromLibrary(db: WikiReaderDatabase): CollectionOption[] {
  const rows = db.collections.list();
  const byId = new Map(rows.map((row) => [row.id, row]));

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return rows
    .map((row) => {
      const parts: string[] = [row.name];
      const seen = new Set<string>([row.id]);
      let parentId = row.parentId;
      while (parentId !== null && !seen.has(parentId)) {
        const parent = byId.get(parentId);
        if (parent === undefined) break;
        seen.add(parentId);
        parts.unshift(parent.name);
        parentId = parent.parentId;
      }
      return {
        name: row.name,
        label: parts.join(' / '),
        ambiguous: (counts.get(row.name.trim().toLowerCase()) ?? 0) > 1,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
