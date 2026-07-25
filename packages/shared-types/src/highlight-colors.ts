/**
 * The highlight palette.
 *
 * Six presets, stored by **name**. A name is a category the user assigns meaning to — "things
 * I disagree with" — and a fixed set keeps that meaning legible where an unbounded picker
 * turns it into forty indistinguishable yellows.
 *
 * Storing the name rather than a hex value is what lets a theme repaint existing highlights:
 * a row written under the light theme holds `tan`, and the reader resolves that to
 * `--wr-highlight-tan`, whatever the current theme sets it to. A stored hex would freeze
 * every old highlight at the colour of the theme it was made under.
 */
import { z } from 'zod';

export const HighlightColorSchema = z.enum([
  'default',
  'tan',
  'spruce',
  'ochre',
  'clay',
  'signal',
]);
export type HighlightColor = z.infer<typeof HighlightColorSchema>;

/** The presets in the order the popover offers them. */
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = HighlightColorSchema.options;

export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = 'default';

/** Human labels for the palette, for titles and screen readers. */
export const HIGHLIGHT_COLOR_LABELS: Readonly<Record<HighlightColor, string>> = {
  default: 'Default',
  tan: 'Tan',
  spruce: 'Spruce',
  ochre: 'Ochre',
  clay: 'Clay',
  signal: 'Signal',
};

/**
 * Read a colour that is already in the database.
 *
 * Reading is deliberately total. Rows written before this enum existed carry a hex literal,
 * and a name could be retired in a later version; in either case the highlight itself is
 * still real, so an unrecognised value renders as `default` instead of throwing and taking
 * the whole annotation list down with it. Writes are the strict side: `HighlightColorSchema`
 * guards every request, so nothing new can enter the database off-palette.
 */
export function resolveHighlightColor(stored: string): HighlightColor {
  const parsed = HighlightColorSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_HIGHLIGHT_COLOR;
}

/** The CSS variable a colour name paints with. Defined in `@wr/shared-ui`'s stylesheet. */
export function highlightColorVariable(color: HighlightColor): string {
  return `var(--wr-highlight-${color})`;
}
