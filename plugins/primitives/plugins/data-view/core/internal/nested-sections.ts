import type { DataViewSection } from "./types";

/**
 * The sections a grouped view draws, given which ones are collapsed: every
 * section but those with a collapsed ANCESTOR (via `nesting.parentKey`). A
 * collapsed section itself stays — its header is what reopens it; its own body
 * is the renderer's to hide.
 *
 * Every view applies it (the flat views through `GroupedSections`, the table
 * over its group rows), so no view can show a collapsed parent's children.
 * Flat sections (no `nesting`) pass through untouched. Relies on tree order —
 * a parent precedes its descendants, which `partitionIntoSections` guarantees.
 */
export function visibleSections<
  S extends Pick<DataViewSection<unknown>, "key" | "nesting">,
>(sections: readonly S[], collapsed: ReadonlySet<string> | undefined): S[] {
  if (!collapsed || collapsed.size === 0) return [...sections];
  // Keys whose descendants are hidden: a collapsed section, and any hidden one.
  const hiding = new Set<string>();
  const out: S[] = [];
  for (const section of sections) {
    const parentKey = section.nesting?.parentKey ?? null;
    const hidden = parentKey !== null && hiding.has(parentKey);
    if (section.key !== null && (hidden || collapsed.has(section.key))) {
      hiding.add(section.key);
    }
    if (!hidden) out.push(section);
  }
  return out;
}
