import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { SelectionBand } from "../internal/selection-bands";

/**
 * The block-selection highlight: one translucent region per selected RUN,
 * painted as a sibling decoration over the block list's grid.
 *
 * The shape (why a run and not a per-row class) is `internal/selection-bands.ts`'s
 * business; this file owns only the appearance, and it is deliberately quiet:
 *
 *  - **A tint, no outline.** An outline is a boundary, and the boundary the user
 *    cares about is the run's — not each block's. Drawing one per row is what
 *    made a plain three-paragraph selection read as three stacked cards.
 *  - **Rounded only where the run actually ends**, so the lines in the middle of
 *    a selection are continuous.
 *  - **`C` to the content box's right edge** — the same box a container's
 *    backdrop fills, so a selected callout's tint and its selection band are
 *    concentric rather than offset by a few pixels — widened, on a line wider
 *    than the column (a `WideBlock` table), to surround what it really paints.
 *
 * Emitted after the container frames and before the rows, so it tints a
 * container's own decoration while the text stays fully legible above it.
 */
export function SelectionBands({ bands }: { bands: readonly SelectionBand[] }) {
  return (
    <>
      {bands.map((band) => (
        <div
          key={band.key}
          aria-hidden
          // How many visible LINES this band covers. The stable hook the e2e
          // specs count selected rows through — they used to match the fill's
          // Tailwind class, which any restyle silently broke.
          data-selection-band={band.end - band.start + 1}
          // eslint-disable-next-line layout/no-adhoc-layout -- grid-row span placement is the point of this element (it is what makes a run ONE rectangle); `relative` gives the tint a positioned box to fill
          className="pointer-events-none relative col-start-1"
          style={{ gridRow: `${band.start + 1} / ${band.end + 2}` }}
        >
          {/* The backdrop fills the row-span box, inset on the left by the
              JS-computed decoration edge `C` (same shape as page/container's
              ContainerBackdrop); a wide line's band overhangs the box on
              both sides (negative `end`, `start` left of `C`). */}
          <Placed
            x={{ start: band.left, end: band.right }}
            y="fill"
            className={cn(
              "bg-primary/15",
              band.roundTop && "rounded-t-md",
              band.roundBottom && "rounded-b-md",
            )}
          />
        </div>
      ))}
    </>
  );
}
