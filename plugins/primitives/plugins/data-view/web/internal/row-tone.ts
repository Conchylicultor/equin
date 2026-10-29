import type { RowTone } from "../../core";

/**
 * The ONE rendering of a {@link RowTone}, shared by every view that honours it —
 * so "muted" cannot mean one thing in the list and another in the gallery.
 *
 * Returns a class only for the non-default tone. `"default"` (and an absent
 * accessor) is deliberately the empty answer rather than `text-foreground`: a
 * view composes this ON TOP of whatever colour its title already carries, and
 * each of the three carries a different one (the list and the gallery state
 * `text-foreground`; the tree inherits). Composed through `cn`, the muted class
 * then wins over the base by tailwind-merge's own conflict resolution.
 */
export function rowToneClass(tone: RowTone | undefined): string | undefined {
  if (tone === "muted") return "text-muted-foreground";
  if (tone === "strong") return "font-semibold";
  return undefined;
}
