import type { DataViewSection, SectionMove } from "./types";

/**
 * Lay `sections` out with `move` applied: the entry keyed `move.id` taken out
 * of the section that holds it and put in `move.dest.groupKey`'s — `zone` of
 * its anchor, else (no anchor, or the anchor not drawn) at the section's head.
 * Both counts follow (the source loses one, the destination gains one, each
 * keeping its kind). The entry carries its attached rows with it.
 *
 * Returns `sections` itself when there is nothing to move: the entry is not
 * drawn (folded, not loaded), it is already in the destination, or the
 * destination section is not drawn — a move is a drawing, never a reason to
 * mint a section.
 */
export function applySectionMove<TRow>(
  sections: DataViewSection<TRow>[],
  move: SectionMove,
): DataViewSection<TRow>[] {
  const { id, dest } = move;
  const from = sections.findIndex((s) => s.entries.some((e) => e.key === id));
  const to = sections.findIndex((s) => s.key === dest.groupKey);
  if (from === -1 || to === -1 || from === to) return sections;
  const source = sections[from]!;
  const entry = source.entries.find((e) => e.key === id)!;
  const target = sections[to]!;
  const entries = [...target.entries];
  const anchor =
    dest.targetId === undefined
      ? -1
      : entries.findIndex((e) => e.key === dest.targetId);
  const at = anchor === -1 ? 0 : dest.zone === "after" ? anchor + 1 : anchor;
  entries.splice(at, 0, entry);
  return sections.map((section, i) => {
    if (i === from) {
      return {
        ...section,
        entries: section.entries.filter((e) => e.key !== id),
        count: { ...section.count, n: Math.max(0, section.count.n - 1) },
      };
    }
    if (i === to) {
      return {
        ...section,
        entries,
        count: { ...section.count, n: section.count.n + 1 },
      };
    }
    return section;
  });
}

/** Every move in order, each over the last one's result. */
export function applySectionMoves<TRow>(
  sections: DataViewSection<TRow>[],
  moves: readonly SectionMove[],
): DataViewSection<TRow>[] {
  return moves.reduce((acc, move) => applySectionMove(acc, move), sections);
}
