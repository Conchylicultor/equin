/**
 * A tab strip's chips as measured at rest (no drag transform applied), in
 * viewport x. Measured once per strip per drag, so the drop index never reads
 * back the shifts it caused.
 */
export interface ChipSlot {
  tabId: string;
  left: number;
  width: number;
}

/** A strip's resting chips and the gap between them. */
export interface StripSlots {
  slots: ChipSlot[];
  gap: number;
}

/**
 * Where a chip centred at `centerX` lands in a strip: the count of the other
 * chips (all but `excludeId`, the dragged chip's own slot) whose centre is left
 * of it — an index among the strip's members without the dragged one, which is
 * what a reorder or merge inserts at.
 */
export function insertionIndex(
  slots: readonly ChipSlot[],
  centerX: number,
  excludeId?: string,
): number {
  let index = 0;
  for (const s of slots) {
    if (s.tabId !== excludeId && s.left + s.width / 2 < centerX) index += 1;
  }
  return index;
}

/**
 * How far each chip (but the dragged one) shifts to show a drop at `index`: the
 * strip re-packed with the dragged chip taken out of its slot (`dragged.tabId`,
 * on its own strip) and a gap of `dragged.width` opened at `index`.
 */
export function chipShifts(
  { slots, gap }: StripSlots,
  index: number,
  dragged: { tabId?: string; width: number },
): Map<string, number> {
  const shifts = new Map<string, number>();
  let x = slots[0]?.left ?? 0;
  let k = 0;
  for (const s of slots) {
    if (s.tabId === dragged.tabId) continue;
    if (k === index) x += dragged.width + gap;
    shifts.set(s.tabId, x - s.left);
    x += s.width + gap;
    k += 1;
  }
  return shifts;
}

/**
 * The dragged chip's horizontal offset on its own strip: the pointer's travel,
 * held within the strip's chips (it slides along the row, never out of it).
 */
export function clampDraggedOffset(
  slots: readonly ChipSlot[],
  tabId: string,
  dx: number,
): number {
  const own = slots.find((s) => s.tabId === tabId);
  const first = slots[0];
  const last = slots[slots.length - 1];
  if (!own || !first || !last) return 0;
  const min = first.left - own.left;
  const max = last.left + last.width - (own.left + own.width);
  return Math.max(min, Math.min(max, dx));
}
