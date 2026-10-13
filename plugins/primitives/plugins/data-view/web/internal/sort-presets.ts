import type {
  FieldDef,
  FilterGroup,
  FilterPreset,
  SortPreset,
  SortRule,
} from "../../core";
import { FilterGroupSchema } from "../../core";
import { splitPinned } from "./pinned-sort";

/**
 * Pure helpers for the saved sort presets feature. Kept dependency-free
 * (no React, no config_v2) so they unit-test in isolation and stay reusable.
 */

/** Coerce a raw direction value to the `"asc" | "desc"` union (default asc). */
function coerceDirection(raw: unknown): "asc" | "desc" {
  return raw === "desc" ? "desc" : "asc";
}

/**
 * Read + normalize the raw config `sortPresets` value into `SortPreset[]`.
 *
 * The config listField injects an `id` onto each preset row AND each rule
 * row; we keep the preset `id` (the delete/rename target) but **strip** it from
 * the rules (a `SortRule` is `{ fieldId, direction }` only). Terse/legacy/absent
 * input tolerated: a missing preset `id` falls back to a stable index-derived id,
 * a non-array (or missing) top-level value yields `[]`, and a row missing
 * `label`/`rules` is skipped.
 */
export function readSortPresets(raw: unknown): SortPreset[] {
  if (!Array.isArray(raw)) return [];
  const presets: SortPreset[] = [];
  raw.forEach((row, index) => {
    if (typeof row !== "object" || row === null) return;
    const r = row as Record<string, unknown>;
    if (typeof r.label !== "string") return;
    const id =
      typeof r.id === "string" && r.id !== "" ? r.id : `preset-${index}`;
    const rawRules = Array.isArray(r.rules) ? r.rules : [];
    const rules: SortRule[] = [];
    for (const rawRule of rawRules) {
      if (typeof rawRule !== "object" || rawRule === null) continue;
      const rule = rawRule as Record<string, unknown>;
      if (typeof rule.fieldId !== "string") continue;
      rules.push({
        fieldId: rule.fieldId,
        direction: coerceDirection(rule.direction),
      });
    }
    presets.push({ id, label: r.label, rules });
  });
  return presets;
}

/**
 * Read + normalize the raw config `filterPresets` value into `FilterPreset[]` —
 * the twin of `readSortPresets`. The config listField injects an `id` onto
 * each preset row; we keep the preset `id` (delete/rename target). The `group`
 * blob is validated as a whole through `FilterGroupSchema` (it is stored opaquely
 * via `jsonField`), so a row with a missing/invalid group is skipped. Terse/
 * legacy/absent input tolerated: a missing preset `id` falls back to a stable
 * index-derived id; a non-array (or missing) top-level value yields `[]`.
 */
export function readFilterPresets(raw: unknown): FilterPreset[] {
  if (!Array.isArray(raw)) return [];
  const presets: FilterPreset[] = [];
  raw.forEach((row, index) => {
    if (typeof row !== "object" || row === null) return;
    const r = row as Record<string, unknown>;
    if (typeof r.label !== "string") return;
    const parsed = FilterGroupSchema.safeParse(r.group);
    if (!parsed.success) return;
    const id =
      typeof r.id === "string" && r.id !== "" ? r.id : `preset-${index}`;
    presets.push({ id, label: r.label, group: parsed.data });
  });
  return presets;
}

/**
 * True when `filter` equals a preset's group by structural JSON identity — the
 * active-indicator predicate (applying a preset writes its `group` verbatim, so
 * the live filter then matches it exactly). The twin of `presetMatchesRules`.
 */
export function filterPresetMatchesGroup(
  preset: FilterPreset,
  filter: FilterGroup | null,
): boolean {
  if (filter === null) return false;
  return JSON.stringify(preset.group) === JSON.stringify(filter);
}

/**
 * Filter a preset's rules to those whose field still resolves (dangling-safe):
 * used both for apply (write only resolvable rules into the live sort) and for
 * the resolvable-count display in the preset row.
 */
export function resolvableRules<TRow>(
  rules: SortRule[],
  sortableFields: FieldDef<TRow>[],
): SortRule[] {
  const byId = new Set(sortableFields.map((f) => f.id));
  return rules.filter((r) => byId.has(r.fieldId));
}

/**
 * The rules a preset saved from the live sort stores: the USER rules only, as
 * plain `{ fieldId, direction }`. Pinned rules belong to the view, not to any
 * preset — applying a preset keeps them (see `applyPresetRules`).
 */
export function presetRulesFromLive(rules: SortRule[]): SortRule[] {
  return splitPinned(rules).user.map((r) => ({
    fieldId: r.fieldId,
    direction: r.direction,
  }));
}

/**
 * The live sort after applying a preset: the current pinned prefix untouched,
 * then the preset's RESOLVABLE rules (a preset that half-resolves applies the
 * half that does) minus any rule on an already-pinned field (a field sorts at
 * most once).
 */
export function applyPresetRules<TRow>(
  current: SortRule[],
  presetRules: SortRule[],
  sortableFields: FieldDef<TRow>[],
): SortRule[] {
  const { pinned } = splitPinned(current);
  const pinnedIds = new Set(pinned.map((r) => r.fieldId));
  return [
    ...pinned,
    ...resolvableRules(presetRules, sortableFields).filter(
      (r) => !pinnedIds.has(r.fieldId),
    ),
  ];
}

/**
 * True when the live USER rules equal a preset's rules by ordered
 * `(fieldId, direction)` — the active-indicator predicate (the live sort, past
 * its pinned prefix, exactly matches the preset).
 */
export function presetMatchesRules(
  preset: SortPreset,
  rules: SortRule[],
): boolean {
  const { user } = splitPinned(rules);
  if (preset.rules.length !== user.length) return false;
  return preset.rules.every((pr, i) => {
    const lr = user[i];
    return (
      lr !== undefined &&
      pr.fieldId === lr.fieldId &&
      pr.direction === lr.direction
    );
  });
}
