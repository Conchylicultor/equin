import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import type { ViewConfigRow } from "../../core";

/**
 * A raw config row as authored on disk. Config is the single source of truth and
 * the authored shape is **terse** — only `{ name, view }` is required; `id` is
 * optional and derived on read (see `normalizeRows`). Array position is the
 * canonical order — there is no `rank`. This lets an agent hand-write
 * `{ "name": "All", "view": { "type": "table" } }` rows without inventing ids.
 * `source` (optional) binds the row to a `ViewSourceEntry` on multi-source
 * surfaces; absent = the implicit sole source.
 */
export interface RawViewRow {
  id?: string;
  name: string;
  /** `null` is the descriptor's healed default — "no icon picked". */
  icon?: SavedSymbolName | null;
  view: VariantValue;
  source?: string;
}

/** Slugify a name into a filename/id-safe token (`"My View" → "my-view"`). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalize raw (possibly terse) config rows into fully-formed `ViewConfigRow`s:
 * derive `id` (explicit `id` ?? slug(name) ?? `view-${index}`). Order is the
 * array position as authored/read — there is no `rank`. Config is the ONLY
 * source — there is no code synthesis. Duplicate derived ids are disambiguated
 * with an index suffix so each row stays addressable.
 *
 * `source` and `icon` are carried via **conditional spread** so a row without
 * them stays byte-identical (`{ id, name, view }`, no extra key) — the
 * JSON-identity reconcile in `useViewsConfig` depends on that. A `null` icon
 * (the descriptor's healed default) normalizes to absent.
 */
export function normalizeRows(raw: RawViewRow[]): ViewConfigRow[] {
  const seenIds = new Set<string>();
  return raw.map((row, i) => {
    let id = row.id ?? slugify(row.name) ?? `view-${i}`;
    if (id === "") id = `view-${i}`;
    while (seenIds.has(id)) id = `${id}-${i}`;
    seenIds.add(id);
    return {
      id,
      name: row.name,
      ...(row.icon != null ? { icon: row.icon } : {}),
      view: row.view,
      ...(row.source !== undefined ? { source: row.source } : {}),
    };
  });
}

/**
 * Reconcile `incoming` onto `prev` with structural sharing: a row whose content
 * is unchanged (same id, same JSON) keeps its PREVIOUS object, and an unchanged
 * list keeps the previous array. An external config change to one view then
 * leaves every other view's row — and its raw `view` value, which the host's
 * per-view getters key their cached state on — untouched.
 */
export function shareRows(
  prev: readonly ViewConfigRow[],
  incoming: readonly ViewConfigRow[],
): ViewConfigRow[] {
  const prevById = new Map(prev.map((r) => [r.id, r]));
  let same = prev.length === incoming.length;
  const next = incoming.map((row, i) => {
    const old = prevById.get(row.id);
    const kept =
      old !== undefined && JSON.stringify(old) === JSON.stringify(row)
        ? old
        : row;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? (prev as ViewConfigRow[]) : next;
}
