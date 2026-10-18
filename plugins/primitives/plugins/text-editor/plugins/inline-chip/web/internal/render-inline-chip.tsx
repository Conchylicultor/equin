import { createElement, type ReactNode } from "react";
import { copiesAsText } from "@plugins/primitives/plugins/dom/plugins/copy-source-text/web";
import { inlineChipFor } from "./inline-registry";
import { ChipBoundary } from "./chip-boundary";

/**
 * THE rendering of one inline token: the chip that owns it, inside its boundary.
 *
 * `null` means no chip claims these characters — every caller renders the raw
 * text instead. That arm is load-bearing, not defensive: it is what lets a
 * document containing a chip node still hydrate and read correctly when the
 * plugin that owns the chip is not in the composition.
 *
 * Two things used to be restated at each render site and are stated here once:
 *
 * - the ANCHORED full-match rule that picks the chip (see `inlineChipFor`), and
 * - the `<ChipBoundary>` an inline chip needs because it never reaches the
 *   screen through `slot-render` (see `./chip-boundary`).
 *
 * Applying the boundary INSIDE means a consumer cannot render a chip
 * unboundaried — there is no way to get the raw component out of the registry.
 *
 * A third thing is stated here once for the same reason: the chip's SOURCE
 * TEXT. This function is the point where `token`'s characters stop being on
 * screen, so it is the only place that still knows what they were — the chip
 * itself is handed the token but renders whatever it likes, and by the time a
 * copy handler sees the DOM the substitution has already happened. Declaring it
 * on a `display:contents` wrapper (no box, no layout effect) is what makes the
 * copy round-trip: see `primitives/dom/copy-source-text`.
 */
export function renderInlineChip(token: string): ReactNode | null {
  const chip = inlineChipFor(token);
  if (!chip) return null;
  return (
    <span className="contents" {...copiesAsText(token)}>
      <ChipBoundary chipId={chip.id} token={token}>
        {createElement(chip.component, { content: token, attrs: {} })}
      </ChipBoundary>
    </span>
  );
}
