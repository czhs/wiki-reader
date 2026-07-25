import {
  AnnotationIdSchema,
  DocumentIdSchema,
  DocumentLocationSchema,
  NoteIdSchema,
  type DocumentLocation,
  type InternalLink,
} from '@wr/shared-types';

/**
 * Internal application links: `document://<id>`, `annotation://<id>`, `note://<id>`.
 *
 * These are not public URLs and are never resolved by the network stack. A location may
 * ride along in the fragment as compact, URL-safe JSON so a link can point at a specific
 * page or section:
 *
 *   document://doc_01j.../#{"kind":"pdf","pageIndex":12}
 *
 * Parsing is total: malformed input yields `null` rather than throwing, because these
 * strings arrive from user-authored note content.
 */

export const INTERNAL_LINK_SCHEMES = ['document', 'annotation', 'note'] as const;
export type InternalLinkScheme = (typeof INTERNAL_LINK_SCHEMES)[number];

const LINK_PATTERN = /^(document|annotation|note):\/\/([^/#?\s]+)(?:\/)?(?:#(.*))?$/;

/** Matches internal links embedded in prose; used to scan note text for references. */
export const INTERNAL_LINK_GLOBAL_PATTERN =
  /\b(document|annotation|note):\/\/[A-Za-z0-9_]+(?:\/)?(?:#\S*)?/g;

function parseLocationFragment(fragment: string | undefined): DocumentLocation | null {
  if (fragment === undefined || fragment.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded);
  } catch {
    return null;
  }
  const parsed = DocumentLocationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Parse a single internal link. Returns `null` for anything unrecognised. */
export function parseInternalLink(input: string): InternalLink | null {
  const match = LINK_PATTERN.exec(input.trim());
  if (match === null) return null;

  const [, scheme, id, fragment] = match;
  if (scheme === undefined || id === undefined) return null;

  const location = parseLocationFragment(fragment);

  switch (scheme) {
    case 'document': {
      const parsed = DocumentIdSchema.safeParse(id);
      if (!parsed.success) return null;
      return location === null
        ? { scheme: 'document', documentId: parsed.data }
        : { scheme: 'document', documentId: parsed.data, location };
    }
    case 'annotation': {
      const parsed = AnnotationIdSchema.safeParse(id);
      if (!parsed.success) return null;
      return { scheme: 'annotation', annotationId: parsed.data };
    }
    case 'note': {
      const parsed = NoteIdSchema.safeParse(id);
      if (!parsed.success) return null;
      if (location === null) return { scheme: 'note', noteId: parsed.data };
      if (location.kind !== 'note') return { scheme: 'note', noteId: parsed.data };
      return { scheme: 'note', noteId: parsed.data, location };
    }
    default:
      return null;
  }
}

/** Serialize an internal link. Inverse of `parseInternalLink`. */
export function formatInternalLink(link: InternalLink): string {
  switch (link.scheme) {
    case 'document': {
      const base = `document://${link.documentId}`;
      return link.location === undefined
        ? base
        : `${base}#${encodeURIComponent(JSON.stringify(link.location))}`;
    }
    case 'annotation':
      return `annotation://${link.annotationId}`;
    case 'note': {
      const base = `note://${link.noteId}`;
      return link.location === undefined
        ? base
        : `${base}#${encodeURIComponent(JSON.stringify(link.location))}`;
    }
    default: {
      const exhaustive: never = link;
      throw new Error(`unhandled internal link: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Extract every well-formed internal link occurring in free text. */
export function extractInternalLinks(text: string): InternalLink[] {
  const out: InternalLink[] = [];
  for (const match of text.matchAll(INTERNAL_LINK_GLOBAL_PATTERN)) {
    const parsed = parseInternalLink(match[0]);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** The entity type an internal link points at, for command and link-graph routing. */
export function internalLinkTarget(
  link: InternalLink,
): { entityType: 'document' | 'annotation' | 'note'; entityId: string } {
  switch (link.scheme) {
    case 'document':
      return { entityType: 'document', entityId: link.documentId };
    case 'annotation':
      return { entityType: 'annotation', entityId: link.annotationId };
    case 'note':
      return { entityType: 'note', entityId: link.noteId };
    default: {
      const exhaustive: never = link;
      throw new Error(`unhandled internal link: ${JSON.stringify(exhaustive)}`);
    }
  }
}
