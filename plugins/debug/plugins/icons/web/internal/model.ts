import {
  MATERIAL_FAMILY,
  type CustomRef,
  type IconFamily,
  type IconFamilyId,
  type SymbolName,
} from "@plugins/ui/plugins/icons/core";
import type { IconSource } from "@plugins/ui/plugins/icons/web";

/**
 * The model behind Debug → Icons, as pure functions over the families, the
 * manifest's names and a resolver — the page passes `resolveIconSource`, the
 * chain `<Icon>` walks, so the page cannot disagree with what an app draws.
 * Names no family: every family comes from `useIconFamilies()`.
 */

/** Where one family's drawing of a name comes from (`resolveIconSource`). */
export type ResolveSource = (
  name: SymbolName,
  family: IconFamilyId,
) => IconSource;

/** The built-in base every chain ends at — a column, never a contribution. */
const MATERIAL_LABEL = "Material";

/** One family as a column of the matrix and a line of the set list. */
export interface FamilyColumn {
  id: IconFamilyId;
  label: string;
  /** `material` is the built-in base; `sprite` a library; `inline` an app's own set. */
  kind: "material" | "sprite" | "inline";
  coverage: "fallback" | "strict";
  /** The family a name it does not map draws from next (Material at the end). */
  fallbackLabel: string | undefined;
  /**
   * Its app-only glyphs (`family.icon("…")`): an inline family's glyphs no
   * Material name maps to. Not in the manifest, so never in its counts.
   */
  appOnly: readonly CustomRef[];
}

/**
 * An inline family's glyphs that none of its `symbols` maps a Material name
 * to — the ones only `family.icon("…")` draws. A sprite family has none.
 */
export function appOnlyGlyphs(family: IconFamily): CustomRef[] {
  if (family.kind !== "inline") return [];
  const mapped = new Set<string>(
    Object.values(family.symbols).filter((g) => g !== undefined),
  );
  return Object.keys(family.glyphs)
    .filter((g) => !mapped.has(g))
    .map((g) => family.icon(g));
}

/** Material first, then every contributed family in the order given. */
export function familyColumns(families: readonly IconFamily[]): FamilyColumn[] {
  const labelOf = familyLabels(families);
  return [
    {
      id: MATERIAL_FAMILY,
      label: MATERIAL_LABEL,
      kind: "material",
      coverage: "strict",
      fallbackLabel: undefined,
      appOnly: [],
    },
    ...families.map((f): FamilyColumn => ({
      id: f.id,
      label: f.label,
      kind: f.kind,
      coverage: f.coverage,
      fallbackLabel: f.coverage === "strict" ? undefined : labelOf(f.fallback),
      appOnly: appOnlyGlyphs(f),
    })),
  ];
}

/** A family id → its label (`material` and an absent fallback: Material). */
export function familyLabels(
  families: readonly IconFamily[],
): (id: IconFamilyId | undefined) => string {
  const labels = new Map(families.map((f) => [f.id, f.label]));
  return (id) =>
    id === undefined || id === MATERIAL_FAMILY
      ? MATERIAL_LABEL
      : (labels.get(id) ?? id);
}

/**
 * What a row says over the columns shown: for a manifest name, the worst of
 * its cells; for an app-only glyph, `only:<family>` — its own group, outside
 * the own / fallback / gap scale (it never falls back).
 */
export type RowStatus = "gap" | "fallback" | "own" | `only:${IconFamilyId}`;

/**
 * What one cell shows: where a family draws a manifest name from
 * (`IconSource`), or — on an app-only glyph's row — `glyph` in its own
 * family's column and `absent` (not in this set) in every other.
 */
export type CellSource = IconSource | { kind: "glyph" } | { kind: "absent" };

/** One row of the matrix: a manifest name, or an app-only glyph. */
export type MatrixRow =
  | {
      kind: "symbol";
      key: string;
      name: SymbolName;
      sources: Readonly<Record<IconFamilyId, IconSource>>;
      status: "gap" | "fallback" | "own";
    }
  | {
      kind: "glyph";
      key: string;
      name: string;
      icon: CustomRef;
      family: IconFamilyId;
      status: `only:${IconFamilyId}`;
    };

/** The group an app-only glyph's row sits in. */
export function onlyStatus(family: IconFamilyId): `only:${IconFamilyId}` {
  return `only:${family}`;
}

/** The row key of an app-only glyph (its own prefix: a glyph may share a manifest name). */
function glyphKey(ref: CustomRef): string {
  return `glyph:${ref.family}/${ref.name}`;
}

/**
 * Every manifest name over the columns shown, then every shown family's
 * app-only glyphs — a hidden family's glyphs leave with its column.
 */
export function matrixRows(
  names: readonly SymbolName[],
  columns: readonly FamilyColumn[],
  resolve: ResolveSource,
): MatrixRow[] {
  const rows: MatrixRow[] = names.map((name) => {
    const sources: Record<IconFamilyId, IconSource> = {};
    let status: "gap" | "fallback" | "own" = "own";
    for (const column of columns) {
      const source = resolve(name, column.id);
      sources[column.id] = source;
      if (source.kind === "gap") status = "gap";
      else if (source.kind === "fallback" && status === "own") {
        status = "fallback";
      }
    }
    return { kind: "symbol", key: name, name, sources, status };
  });
  for (const column of columns) {
    for (const icon of column.appOnly) {
      rows.push({
        kind: "glyph",
        key: glyphKey(icon),
        name: icon.name,
        icon,
        family: column.id,
        status: onlyStatus(column.id),
      });
    }
  }
  return rows;
}

/** What a row's cell in one family's column shows. */
export function cellOf(row: MatrixRow, family: IconFamilyId): CellSource {
  if (row.kind === "glyph") {
    return row.family === family ? { kind: "glyph" } : { kind: "absent" };
  }
  const source = row.sources[family];
  if (source === undefined) {
    throw new Error(`[debug/icons] row ${row.name} has no cell for ${family}`);
  }
  return source;
}

/** "Fallbacks only": a row with a gap or a fallback — never an app-only glyph. */
export function fallsBack(row: MatrixRow): boolean {
  return row.status === "gap" || row.status === "fallback";
}

/** The Coverage groups: the three over manifest names, then one per family with app-only glyphs. */
export function statusOptions(
  columns: readonly FamilyColumn[],
): { value: RowStatus; label: string }[] {
  return [
    { value: "gap", label: "A set has a gap" },
    { value: "fallback", label: "A set falls back" },
    { value: "own", label: "Every set draws it" },
    ...columns
      .filter((c) => c.appOnly.length > 0)
      .map((c) => ({ value: onlyStatus(c.id), label: `${c.label} only` })),
  ];
}

/** One tile of By set: a manifest name as one family draws it, or one of its app-only glyphs. */
export interface TileRow {
  key: string;
  family: IconFamilyId;
  /** The tile's group: the family's id, or `only:<family>` for its app-only glyphs (right after it). */
  group: string;
  name: string;
  drawn:
    | { kind: "symbol"; name: SymbolName; source: IconSource }
    | { kind: "glyph"; icon: CustomRef };
}

/** By set's tiles: per family shown, every manifest name, then its app-only glyphs. */
export function tileRows(
  names: readonly SymbolName[],
  columns: readonly FamilyColumn[],
  resolve: ResolveSource,
  fallbacksOnly: boolean,
): TileRow[] {
  const tiles: TileRow[] = [];
  for (const column of columns) {
    for (const name of names) {
      const source = resolve(name, column.id);
      if (fallbacksOnly && source.kind === "own") continue;
      tiles.push({
        key: `${column.id}/${name}`,
        family: column.id,
        group: column.id,
        name,
        drawn: { kind: "symbol", name, source },
      });
    }
    if (fallbacksOnly) continue;
    for (const icon of column.appOnly) {
      tiles.push({
        key: glyphKey(icon),
        family: column.id,
        group: onlyStatus(column.id),
        name: icon.name,
        drawn: { kind: "glyph", icon },
      });
    }
  }
  return tiles;
}

/** By set's Set groups: each family, its app-only glyphs right after it. */
export function tileGroupOptions(
  columns: readonly FamilyColumn[],
): { value: string; label: string }[] {
  return columns.flatMap((c) => [
    { value: c.id, label: c.label },
    ...(c.appOnly.length > 0
      ? [{ value: onlyStatus(c.id), label: `${c.label} · own glyphs` }]
      : []),
  ]);
}

/** How much of the manifest one family draws itself. */
export interface FamilyCounts {
  own: number;
  fallback: number;
  gap: number;
  total: number;
}

export function familyCounts(
  names: readonly SymbolName[],
  family: IconFamilyId,
  resolve: ResolveSource,
): FamilyCounts {
  const counts: FamilyCounts = {
    own: 0,
    fallback: 0,
    gap: 0,
    total: names.length,
  };
  for (const name of names) counts[resolve(name, family).kind]++;
  return counts;
}

/**
 * The badge a fallback cell wears: the initial of the family that draws it
 * ("L", "M"). None on a cell the family draws itself, or a gap.
 */
export function fallbackBadge(
  source: CellSource,
  labelOf: (id: IconFamilyId) => string,
): string | undefined {
  if (source.kind !== "fallback") return undefined;
  return labelOf(source.family).charAt(0).toUpperCase();
}

/** An app and the family its theme draws its icons in. */
export interface AppFamily {
  appId: string;
  appName: string;
  family: IconFamilyId;
}

/** One line of the set list: an app's own set, or a library. */
export interface SetRow {
  /** Unique per line: `app:<id>`, or `family:<id>` for a family no app picks. */
  key: string;
  group: "app" | "library";
  family: FamilyColumn;
  /** The app's name for an app set, the family's label for a library. */
  title: string;
  /** The apps whose theme draws in this family. */
  apps: readonly string[];
  /** Over the manifest's names only. */
  counts: FamilyCounts;
  /** How many app-only glyphs the family draws beyond the manifest (`FamilyColumn.appOnly`). */
  appOnly: number;
}

/**
 * The set list: every app whose family is an inline (app-drawn) set — plus an
 * inline set no app picks — under "app"; Material and every sprite family
 * under "library", with the apps drawing in each.
 */
export function setRows(
  columns: readonly FamilyColumn[],
  apps: readonly AppFamily[],
  countsOf: (family: IconFamilyId) => FamilyCounts,
): SetRow[] {
  const appsOf = (id: IconFamilyId) =>
    apps.filter((a) => a.family === id).map((a) => a.appName);
  const rows: SetRow[] = [];
  for (const column of columns) {
    const counts = countsOf(column.id);
    if (column.kind !== "inline") {
      rows.push({
        key: `family:${column.id}`,
        group: "library",
        family: column,
        title: column.label,
        apps: appsOf(column.id),
        counts,
        appOnly: column.appOnly.length,
      });
      continue;
    }
    const owners = apps.filter((a) => a.family === column.id);
    if (owners.length === 0) {
      rows.push({
        key: `family:${column.id}`,
        group: "app",
        family: column,
        title: column.label,
        apps: [],
        counts,
        appOnly: column.appOnly.length,
      });
    }
    for (const owner of owners) {
      rows.push({
        key: `app:${owner.appId}`,
        group: "app",
        family: column,
        title: owner.appName,
        apps: [owner.appName],
        counts,
        appOnly: column.appOnly.length,
      });
    }
  }
  return rows;
}
