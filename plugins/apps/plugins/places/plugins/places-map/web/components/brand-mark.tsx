import { conicSlices } from "../internal/pin-paint";

/** The mark's four slices: the seeded tree's first top-level colours. */
const BRAND_FILL = conicSlices(
  [
    ["#f97316", 1],
    ["#3b82f6", 1],
    ["#16a34a", 1],
    ["#a855f7", 1],
  ],
  45,
);

/** The sidebar header's mark: a small drop sliced in four tag colours. */
export function BrandMark() {
  return (
    <span
      aria-hidden
      className="inline-block size-6 -rotate-45 rounded-full rounded-bl-none border-2 border-categorical-foreground shadow-sm"
      style={{ background: BRAND_FILL }}
    />
  );
}
