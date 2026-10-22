import type { Theme, ThemeId } from "@plugins/ui/plugins/theme-engine/core";
import type {
  ThemeSelection,
  ThemeSourceEntry,
} from "@plugins/ui/plugins/theme-engine/web";

/** A theme's swatch colors per mode: its color-palette token values (`primary`, `background`, …). */
export type ThemePreview = ThemeSourceEntry["preview"];

/** A scope that selects a row's theme, with the name the gallery shows for it. */
export interface ThemeUse {
  scopeId: string | undefined;
  label: string;
}

/**
 * What activating a row does. A `resident` row is a theme that exists and can
 * be selected as it is; a `browse` row is a catalog entry that must be saved
 * (its source's `useAdopt()`) before it can be selected.
 */
export type ThemeRowTarget =
  | { kind: "resident"; theme: Theme }
  | { kind: "browse"; sourceId: string; entryId: string };

/** One theme in the gallery — every field the Theme DataView filters, sorts and draws on. */
export interface ThemeRow {
  key: string;
  label: string;
  /** Where it comes from: a resident theme's own `source`, or the id of the browse source offering it. */
  source: string;
  /** The browse sources that list this theme — kept on a saved catalog theme, so it stays in its catalog's view. */
  catalogs: string[];
  tags: string[];
  /** Resident (selectable now) rather than a catalog entry still to be saved. */
  saved: boolean;
  usedBy: ThemeUse[];
  preview: ThemePreview;
  target: ThemeRowTarget;
}

/** One browse source's catalog, as its `useEntries` returned it. */
export interface BrowseListing {
  sourceId: string;
  entries: readonly ThemeSourceEntry[];
}

/**
 * Build the gallery's rows: every resident theme plus every browse entry that
 * is not saved yet.
 *
 * A catalog entry that is already saved (`savedThemeId`) is not a second row —
 * the resident theme it became stands in for it, carrying the entry's tags and
 * catalog. It also takes the entry's POSITION: themes no catalog lists come
 * first, in `themes` order, then each catalog in its own order. So picking a
 * catalog card saves it without moving it, and a catalog view reads the same
 * before and after.
 */
export function buildThemeRows(input: {
  /** Every resident theme, in the order to show them (code themes first). */
  themes: readonly Theme[];
  browse: readonly BrowseListing[];
  selections: readonly ThemeSelection[];
  scopeLabel: (scopeId: string | undefined) => string;
  previewOf: (theme: Theme) => ThemePreview;
}): ThemeRow[] {
  const byId = new Map(input.themes.map((t) => [t.id, t]));

  const usedBy = new Map<ThemeId, ThemeUse[]>();
  for (const { scopeId, themeId } of input.selections) {
    const uses = usedBy.get(themeId) ?? [];
    uses.push({ scopeId, label: input.scopeLabel(scopeId) });
    usedBy.set(themeId, uses);
  }

  // What the catalogs say about the themes they list once saved.
  const listed = new Map<ThemeId, { catalogs: string[]; tags: string[] }>();
  for (const { sourceId, entries } of input.browse) {
    for (const entry of entries) {
      if (entry.savedThemeId === undefined || !byId.has(entry.savedThemeId)) {
        continue;
      }
      const info = listed.get(entry.savedThemeId) ?? { catalogs: [], tags: [] };
      if (!info.catalogs.includes(sourceId)) info.catalogs.push(sourceId);
      for (const tag of entry.tags) {
        if (!info.tags.includes(tag)) info.tags.push(tag);
      }
      listed.set(entry.savedThemeId, info);
    }
  }

  const residentRow = (theme: Theme): ThemeRow => {
    const info = listed.get(theme.id);
    return {
      key: residentRowKey(theme.id),
      label: theme.label,
      source: theme.source,
      catalogs: info?.catalogs ?? [],
      tags: info?.tags ?? [],
      saved: true,
      usedBy: usedBy.get(theme.id) ?? [],
      preview: input.previewOf(theme),
      target: { kind: "resident", theme },
    };
  };

  const rows: ThemeRow[] = [];
  for (const theme of input.themes) {
    if (!listed.has(theme.id)) rows.push(residentRow(theme));
  }
  const emitted = new Set<ThemeId>();
  for (const { sourceId, entries } of input.browse) {
    for (const entry of entries) {
      const saved =
        entry.savedThemeId === undefined
          ? undefined
          : byId.get(entry.savedThemeId);
      if (saved) {
        // Listed by two catalogs ⇒ shown once, where the first one lists it.
        if (emitted.has(saved.id)) continue;
        emitted.add(saved.id);
        rows.push(residentRow(saved));
        continue;
      }
      rows.push({
        key: browseRowKey(sourceId, entry.id),
        label: entry.label,
        source: sourceId,
        catalogs: [sourceId],
        tags: entry.tags,
        saved: false,
        usedBy: [],
        preview: entry.preview,
        target: { kind: "browse", sourceId, entryId: entry.id },
      });
    }
  }
  return rows;
}

// Row keys carry their kind as a prefix, so a resident theme's key and a
// catalog entry's can never collide whatever characters the ids hold.

/** The row key of resident theme `id` — what a surface passes as the selected row. */
export function residentRowKey(id: ThemeId): string {
  return `theme/${id}`;
}

function browseRowKey(sourceId: string, entryId: string): string {
  return `entry/${sourceId}/${entryId}`;
}
