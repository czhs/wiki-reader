/**
 * The Typst compiler (criteria S04–S07).  [MAIN ONLY]
 *
 * The notebook's source language is Typst, and Typst is compiled here — in the main process,
 * by a **vendored** compiler: `@myriaddreamin/typst-ts-node-compiler`, a native addon carrying
 * the whole of Typst and its fonts. No CDN, no download, nothing fetched to draw a page.
 *
 * Three decisions worth reading before writing near this.
 *
 * **Why not in the renderer.** There is a WASM build of the same compiler. Loading it would
 * need `'wasm-unsafe-eval'` in the window's `script-src`, which is a permanent widening of the
 * one CSP this app's security rests on, bought for a latency saving that measurement puts at
 * under a millisecond: a warm compile of a block is ~0.7 ms and the round trip is the cost. So
 * the compiler stays on this side, where the renderer's UI thread is a different *process*
 * from the one doing the work — which is what makes "a slow compile must never hold a
 * keystroke" (`S07`) structural rather than careful.
 *
 * **Why the network guard is not optional.** The compiler links an HTTP client and resolves
 * `#import "@preview/…"` out of `packages.typst.org`. There is no argument that turns the
 * registry off. So `refuseNetworkImports` runs in front of every compile — the source never
 * reaches the compiler — and the refusal is a sentence rather than a silence.
 *
 * **Why two targets.** `html` answers a tree with the text still in it, which is what keeps a
 * click placeable back into the source (`P05`), the outline able to find its headings, and an
 * `annotation://` link a link. `svg` answers the typeset page for the live render (`S07`),
 * whose glyphs are `<path>` elements — it has no text in it at all, which is exactly why it can
 * never quietly become the editing surface.
 *
 * Nothing here ever hands anyone a filesystem path. Headers are virtual files under a
 * workspace root that does not exist on disk, and a picture's bytes are mounted at
 * `/img/<internal file id>` — the id is the name inside the document, and the bytes are fetched
 * through the same allow-list `rrfile://` uses.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  TypstSettingsSchema,
  type TypstNode,
  type TypstSettings,
} from '@wr/shared-types';
import {
  TYPST_GLOBAL_HEADER_PATH,
  TYPST_IMAGE_ROOT,
  TYPST_LOCAL_HEADER_PATH,
  refuseNetworkImports,
  typstPrelude,
} from '@wr/document-model';
import type { AppServices } from './services.js';
import { resolveFileRequest } from './protocol.js';

const SETTINGS_KEY = 'typst.settings';

/**
 * Maths would otherwise vanish.
 *
 * Typst's HTML export has no equation element, and a document containing `$x^2$` compiles
 * **without error** and emits the sentence with the formula simply gone. A silent drop of the
 * researcher's mathematics is the worst failure this module could have, so the fix is Typst's
 * own show rule rather than a regex over the source: every equation, inline or displayed, is
 * typeset to a frame and inlined as an SVG image. One rule, one place, and no parsing of a
 * language this file does not otherwise parse.
 */
const MATH_AS_FRAMES = '#show math.equation: it => html.frame(it)\n';

/** Which elements a compiled page may put in the window. */
const ALLOWED_TAGS = new Set([
  'p', 'em', 'strong', 'del', 'sub', 'sup', 'br',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'figure', 'figcaption', 'a', 'img', 'span', 'div', 'section',
]);

/**
 * Which attributes survive, per element.
 *
 * An allow-list, the way `math.tsx` allow-lists MathML, and for the same reason: a Typst page
 * is the researcher's own text, but an excerpt inside it came out of a PDF off the open web,
 * so the tree is untrusted for exactly the reason `quoteText` escapes. `style` is absent on
 * purpose — there is no attribute here that can carry a URL the window would fetch.
 */
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'class', 'cite', 'title', 'data-lang']);

/** A picture is inlined by the compiler; nothing else may be a source of bytes. */
const isSafeSrc = (value: string): boolean => value.startsWith('data:image/');

interface Compiler {
  addSource(path: string, source: string): void;
  mapShadow(path: string, content: Buffer): void;
  evictCache(maxAge: number): void;
  svg(compiledOrBy: unknown): string;
  compile(args: unknown): { result: unknown; hasError(): boolean; takeDiagnostics(): Diagnostics };
  tryHtml(args: unknown): {
    result: { hast(): unknown } | null;
    hasError(): boolean;
    takeDiagnostics(): Diagnostics;
  };
}

interface Diagnostics {
  readonly shortDiagnostics: readonly { readonly message?: unknown }[];
}

export interface TypstRenderRequest {
  readonly questionId: string | null;
  readonly source: string;
  readonly target: 'html' | 'svg';
  readonly widthPt: number;
}

export interface TypstRenderResult {
  readonly tree: TypstNode | null;
  readonly svg: string | null;
  readonly error: string | null;
}

type TypstServices = Pick<AppServices, 'db' | 'allowed' | 'logger'>;

/**
 * One compiler for the application.
 *
 * Creation costs ~50 ms and a warm compile 0.7 ms, so it is made once, lazily — a tree that
 * never opens a notebook never loads a 46 MB addon — and the cache is evicted on the schedule
 * the compiler's own documentation suggests for watch-style tools.
 */
export class TypstService {
  #compiler: Compiler | null = null;
  #shadowed = new Set<string>();
  #compiles = 0;
  readonly #root: string;

  constructor(private readonly services: TypstServices) {
    // A virtual root. Nothing is written here and the directory need not exist: every file the
    // compiler can see is one this process handed it in memory.
    this.#root = join('/', 'wiki-reader', 'typst');
  }

  settings(): TypstSettings {
    const parsed = TypstSettingsSchema.safeParse(this.services.db.settings.get(SETTINGS_KEY));
    return parsed.success ? parsed.data : TypstSettingsSchema.parse({});
  }

  /**
   * Change the settings, refusing a global header that does not compile.
   *
   * A broken global header breaks *every* notebook at once, so it is compiled alone before it
   * is stored and the last good one is left in place when it fails. The placement setting is
   * saved either way: it cannot be wrong, and losing it because a header had a typo in it
   * would be the app punishing the wrong gesture.
   */
  async saveSettings(change: {
    readonly globalHeader?: string | undefined;
    readonly stackedPlacement?: TypstSettings['stackedPlacement'] | undefined;
  }): Promise<{ settings: TypstSettings; error: string | null }> {
    const current = this.settings();
    let error: string | null = null;
    let globalHeader = current.globalHeader;
    if (change.globalHeader !== undefined) {
      error = await this.checkHeader(change.globalHeader);
      if (error === null) globalHeader = change.globalHeader;
    }
    const next = TypstSettingsSchema.parse({
      globalHeader,
      stackedPlacement: change.stackedPlacement ?? current.stackedPlacement,
    });
    this.services.db.settings.set(SETTINGS_KEY, next);
    return { settings: next, error };
  }

  /** Why this header cannot be stored, or `null` when it can (`S05`). */
  async checkHeader(header: string): Promise<string | null> {
    const refusal = refuseNetworkImports(header);
    if (refusal !== null) return refusal;
    // Compiled as a document with the header as its only content: a `#let` that does not parse
    // fails here, which is the whole question being asked.
    const compiler = this.#load();
    if (compiler === null) return 'The Typst compiler is not available in this build.';
    const done = compiler.tryHtml({ mainFileContent: `${header}\n` });
    return done.hasError() ? describe(done.takeDiagnostics()) : null;
  }

  async render(request: TypstRenderRequest): Promise<TypstRenderResult> {
    const refusal = refuseNetworkImports(request.source);
    if (refusal !== null) return { tree: null, svg: null, error: refusal };

    const compiler = this.#load();
    if (compiler === null) {
      return { tree: null, svg: null, error: 'The Typst compiler is not available in this build.' };
    }

    const settings = this.settings();
    const local =
      request.questionId === null ? '' : this.services.db.questions.readTypstHeader(request.questionId);
    compiler.addSource(this.#virtual(TYPST_GLOBAL_HEADER_PATH), `${settings.globalHeader}\n`);
    compiler.addSource(this.#virtual(TYPST_LOCAL_HEADER_PATH), `${local}\n`);
    await this.#mountPictures(compiler, request.source);

    const prelude =
      request.target === 'html'
        ? `${MATH_AS_FRAMES}${typstPrelude()}`
        : `#set page(width: ${String(Math.round(request.widthPt))}pt, height: auto, margin: 8pt)\n${typstPrelude()}`;
    const mainFileContent = `${prelude}${request.source}`;

    try {
      if (request.target === 'svg') {
        const done = compiler.compile({ mainFileContent });
        if (done.hasError() || done.result === null) {
          return { tree: null, svg: null, error: describe(done.takeDiagnostics()) };
        }
        return { tree: null, svg: compiler.svg(done.result), error: null };
      }
      const done = compiler.tryHtml({ mainFileContent });
      const result = done.result;
      if (done.hasError() || result === null) {
        return { tree: null, svg: null, error: describe(done.takeDiagnostics()) };
      }
      return { tree: sanitize(result.hast()), svg: null, error: null };
    } finally {
      this.#compiles += 1;
      // The suggested rhythm for a watch-style tool: often enough that a page being typed in
      // does not grow the memoization table without bound, rarely enough that the 0.7 ms warm
      // compile stays warm.
      if (this.#compiles % 64 === 0) compiler.evictCache(30);
    }
  }

  #virtual(path: string): string {
    return join(this.#root, path.replace(/^\/+/u, ''));
  }

  #load(): Compiler | null {
    if (this.#compiler !== null) return this.#compiler;
    try {
      // Required lazily and by expression so that a tree without the optional platform binary
      // installed still starts — the notebook says why it cannot render rather than the window
      // failing to open.
      const module = createRequire(import.meta.url)(
        '@myriaddreamin/typst-ts-node-compiler',
      ) as { NodeCompiler: { create(args: { workspace: string }): Compiler } };
      this.#compiler = module.NodeCompiler.create({ workspace: this.#root });
      return this.#compiler;
    } catch (failure) {
      this.services.logger.warn('typst compiler unavailable', {
        reason: failure instanceof Error ? failure.message : String(failure),
      });
      return null;
    }
  }

  /**
   * Give the compiler the bytes for every picture the source names (`S06`).
   *
   * `#image("/img/<file id>")` — the name in the document is an internal file id and nothing
   * else, and the bytes come through `resolveFileRequest`, which is the same allow-list
   * `rrfile://` goes through. So a document cannot name a path, this cannot build one out of
   * what a document said, and a row pointing outside the allowed roots is refused here for the
   * same reason the window refuses it.
   */
  async #mountPictures(compiler: Compiler, source: string): Promise<void> {
    const wanted = new Set<string>();
    for (const found of source.matchAll(/"\/img\/(dfl_[0-9a-hjkmnp-tv-z]{26})"/gu)) {
      const id = found[1];
      if (id !== undefined && !this.#shadowed.has(id)) wanted.add(id);
    }
    for (const fileId of wanted) {
      const resolved = await resolveFileRequest(this.services, `rrfile://${fileId}/`);
      if (!resolved.ok) continue;
      try {
        compiler.mapShadow(
          this.#virtual(`${TYPST_IMAGE_ROOT}${fileId}`),
          await readFile(resolved.path),
        );
        this.#shadowed.add(fileId);
      } catch (failure) {
        this.services.logger.warn('typst picture unreadable', {
          fileId,
          reason: failure instanceof Error ? failure.message : String(failure),
        });
      }
    }
  }
}

/** The first thing the compiler objected to, as a sentence. */
function describe(diagnostics: Diagnostics | null): string {
  const first = diagnostics?.shortDiagnostics[0];
  const message = typeof first?.message === 'string' ? first.message : null;
  return message === null ? 'This block does not compile.' : `Typst: ${message}`;
}

/**
 * A HAST tree, narrowed to what may be drawn.
 *
 * The `<html>`/`<head>` wrapper the compiler emits is dropped — a compiled block belongs inside
 * a page that already exists — and everything under `<body>` is walked once, keeping only
 * allow-listed tags and attributes. An element that is not on the list is *unwrapped* rather
 * than deleted: its children are the researcher's words, and losing a sentence because Typst
 * grew a new wrapper element would be the same silent drop the maths rule exists to prevent.
 */
function sanitize(hast: unknown): TypstNode {
  const body = findBody(hast) ?? hast;
  return { type: 'element', tag: 'div', props: {}, children: convert(body).flatMap(unwrapRoot) };
}

const unwrapRoot = (node: TypstNode): TypstNode[] =>
  node.type === 'element' && node.tag === 'body' ? [...(node.children ?? [])] : [node];

interface HastLike {
  readonly type?: unknown;
  readonly tagName?: unknown;
  readonly value?: unknown;
  readonly properties?: Record<string, unknown>;
  readonly children?: readonly unknown[];
}

function findBody(node: unknown): unknown {
  const candidate = node as HastLike | null;
  if (candidate === null || typeof candidate !== 'object') return null;
  if (candidate.tagName === 'body') return candidate;
  for (const child of candidate.children ?? []) {
    const found = findBody(child);
    if (found !== null) return found;
  }
  return null;
}

function convert(node: unknown): TypstNode[] {
  const candidate = node as HastLike | null;
  if (candidate === null || typeof candidate !== 'object') return [];
  if (candidate.type === 'text') {
    const value = typeof candidate.value === 'string' ? candidate.value : '';
    return value === '' ? [] : [{ type: 'text', value }];
  }
  if (candidate.type !== 'element') return [];
  const children = (candidate.children ?? []).flatMap(convert);
  const tag = typeof candidate.tagName === 'string' ? candidate.tagName : '';
  if (tag === 'body') return [{ type: 'element', tag: 'body', props: {}, children }];
  if (!ALLOWED_TAGS.has(tag)) return children;

  const props: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidate.properties ?? {})) {
    if (!ALLOWED_ATTRS.has(name)) continue;
    const text = Array.isArray(value) ? value.join(' ') : String(value);
    if (name === 'src' && !isSafeSrc(text)) continue;
    props[name] = text;
  }
  return [{ type: 'element', tag, props, children }];
}

const SERVICES = new WeakMap<TypstServices, TypstService>();

/** The one compiler for these services, made on first use. */
export function typstService(services: TypstServices): TypstService {
  const existing = SERVICES.get(services);
  if (existing !== undefined) return existing;
  const made = new TypstService(services);
  SERVICES.set(services, made);
  return made;
}
