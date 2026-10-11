import { CheckboxIndicator } from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { copiesAsText } from "@plugins/primitives/plugins/dom/plugins/copy-source-text/core";

/**
 * A checklist line's box, sitting in the text run — the agent's checklist rows,
 * the draft and the sent message alike. It copies as the `- [ ] ` / `- [x] `
 * it stands for, so a copied line reads as the line the agent wrote; the words
 * after it stay ordinary, selectable text.
 */
export function PickedBox({ checked = true }: { checked?: boolean }) {
  return (
    <Inline
      gap="none"
      className="select-none pr-xs align-middle"
      {...copiesAsText(`- [${checked ? "x" : " "}] `)}
    >
      <CheckboxIndicator checked={checked} />
    </Inline>
  );
}
