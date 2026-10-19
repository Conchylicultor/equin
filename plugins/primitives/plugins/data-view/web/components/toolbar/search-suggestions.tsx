import { useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Popover,
  PopoverContent,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { isInToast } from "@plugins/shell/plugins/toast/web";
import type { DataViewSearchSuggestions } from "../../../core";

/** What ArrowDown can land on inside the panel. */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The search field with its suggestions panel (`DataViewSearch.suggestions`):
 * the panel hangs under the field, non-modal — focus stays in the field, so
 * typing goes on while it is open. The field taking focus or being typed in
 * opens it; Escape and a press outside both the field and the panel close it
 * (a press on the field itself is not "outside": the panel is the field's; nor
 * is one on a toast, whose Undo is about what the panel shows).
 * ArrowDown moves into the panel's first control.
 */
export function SearchWithSuggestions({
  input,
  inputRef,
  suggestions,
}: {
  input: ReactNode;
  inputRef: RefObject<HTMLInputElement | null>;
  suggestions: DataViewSearchSuggestions;
}): ReactNode {
  // State, not a ref: the positioner reads the anchor while rendering.
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { open, onOpenChange } = suggestions;
  return (
    <Popover
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (next) {
          onOpenChange(true);
          return;
        }
        // Not "outside": the field (the panel is its own), and a toast (its
        // Undo is about what the panel shows).
        const target = details.event?.target;
        if (
          target instanceof Node &&
          (anchor?.contains(target) === true || isInToast(target))
        )
          return;
        onOpenChange(false);
        if (details.reason === "escape-key") inputRef.current?.blur();
      }}
    >
      {/* The anchor box: the field's own focus and typing open the panel. */}
      <div
        ref={setAnchor}
        onFocus={() => onOpenChange(true)}
        onInput={() => onOpenChange(true)}
        onKeyDown={(e) => {
          // Focus stays in the field, outside the popup, where base-ui's own
          // Escape dismissal does not listen: the field closes the panel.
          if (e.key === "Escape" && open) {
            e.preventDefault();
            onOpenChange(false);
            inputRef.current?.blur();
            return;
          }
          if (e.key !== "ArrowDown" || !open) return;
          const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
          if (first === null || first === undefined) return;
          e.preventDefault();
          first.focus();
        }}
      >
        {input}
      </div>
      <PopoverContent
        anchor={anchor}
        align="end"
        width="2xl"
        padding="none"
        maxHeight="viewport"
        // Always under the field: a panel taller than the room below scrolls
        // (the viewport cap) rather than flipping beside the field.
        collisionAvoidance={{ side: "none" }}
        initialFocus={false}
        finalFocus={false}
      >
        <div ref={panelRef}>{suggestions.content}</div>
      </PopoverContent>
    </Popover>
  );
}
