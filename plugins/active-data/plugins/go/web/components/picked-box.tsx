import { CheckboxIndicator } from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { copiesAsText } from "@plugins/primitives/plugins/dom/plugins/copy-source-text/web";

/**
 * An item's box, sitting in the text run — the agent's checklist rows and
 * table rows, the draft and the sent message alike. It copies as the mark it
 * stands for — `- [ ] ` / `- [x] ` on a checklist line, `[ ] ` / `[x] ` in a
 * table's first cell — so a copied item reads as the agent wrote it; the words
 * after it stay ordinary, selectable text.
 */
export function PickedBox({
  checked = true,
  form = "line",
}: {
  /** `"pending"`: the picks are not known yet (still loading) — an empty,
   *  pulsing box in the box's own place, never a guess at the pick. */
  checked?: PickState;
  form?: "line" | "cell";
}) {
  const mark = `[${checked === true ? "x" : " "}] `;
  return (
    <Inline
      gap="none"
      className="select-none pr-xs align-middle"
      {...copiesAsText(form === "line" ? `- ${mark}` : mark)}
    >
      <CheckboxIndicator
        checked={checked === true}
        className={checked === "pending" ? "animate-pulse" : undefined}
      />
    </Inline>
  );
}

/** One item's pick: on, off, or not known yet. */
export type PickState = boolean | "pending";
