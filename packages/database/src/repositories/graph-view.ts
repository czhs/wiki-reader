import {
  GraphViewSettingsSchema,
  GraphViewportSchema,
  type GraphViewSettings,
  type GraphViewport,
  type LinkableEntityType,
} from '@wr/shared-types';
import type { SettingsRepository } from './settings.js';

const SETTINGS_KEY = 'graph.view.settings';
const VIEWPORTS_KEY = 'graph.view.viewports';

/**
 * How many seeds' viewports are remembered.
 *
 * Someone who opens the graph on every paper they read would otherwise grow one settings row
 * without bound. Oldest-written is dropped first, so the graphs recently worked on are the
 * ones that come back where they were left.
 */
const VIEWPORT_LIMIT = 64;

const seedKey = (entityType: LinkableEntityType, entityId: string): string =>
  `${entityType} ${entityId}`;

interface StoredViewport {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/**
 * The graph's view state: how it is drawn, and where each seed's graph was left.
 *
 * Both are preferences rather than content, so they live in `settings` rather than in tables
 * of their own — there is nothing to join them to and nothing that queries across them.
 *
 * Everything read back out is parsed with the same schema the IPC contract uses. A settings
 * row is a text blob that a person can edit; a value that no longer parses sends the view to
 * its default rather than into the renderer, which is the same rule
 * `SettingsRepository` follows for JSON it cannot read at all.
 */
export class GraphViewRepository {
  constructor(private readonly settings: SettingsRepository) {}

  /** The stored drawing preferences, or the schema's defaults when nothing is stored. */
  viewSettings(): GraphViewSettings {
    const parsed = GraphViewSettingsSchema.safeParse(this.settings.get(SETTINGS_KEY));
    return parsed.success ? parsed.data : GraphViewSettingsSchema.parse({});
  }

  saveViewSettings(next: GraphViewSettings): GraphViewSettings {
    const validated = GraphViewSettingsSchema.parse(next);
    this.settings.set(SETTINGS_KEY, validated);
    return validated;
  }

  viewport(entityType: LinkableEntityType, entityId: string): GraphViewport | null {
    const wanted = seedKey(entityType, entityId);
    const found = this.#stored().find((entry) => entry.key === wanted);
    if (found === undefined) return null;
    const parsed = GraphViewportSchema.safeParse({ x: found.x, y: found.y, zoom: found.zoom });
    return parsed.success ? parsed.data : null;
  }

  saveViewport(
    entityType: LinkableEntityType,
    entityId: string,
    viewport: GraphViewport,
  ): GraphViewport {
    const validated = GraphViewportSchema.parse(viewport);
    const key = seedKey(entityType, entityId);
    // Rewritten at the end of the list, so writing a seed's viewport also makes it the most
    // recently used one and the last to be evicted.
    const kept = this.#stored().filter((entry) => entry.key !== key);
    kept.push({ key, ...validated });
    this.settings.set(VIEWPORTS_KEY, kept.slice(-VIEWPORT_LIMIT));
    return validated;
  }

  #stored(): StoredViewport[] {
    const raw = this.settings.get(VIEWPORTS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const key = record['key'];
      const parsed = GraphViewportSchema.safeParse(record);
      if (typeof key !== 'string' || key.length === 0 || !parsed.success) return [];
      return [{ key, ...parsed.data }];
    });
  }
}
