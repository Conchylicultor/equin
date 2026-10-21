import { useEffect, useState, type ReactNode } from "react";
import type { UiContextMeta } from "@plugins/primitives/plugins/ui-context/core";
import { collectMeta } from "@plugins/primitives/plugins/ui-context/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { useHoldPopoverOpen } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { PickerOverlay } from "./picker-overlay";

export interface ElementPickerProps {
  /** The picked element's metadata. The picker has already disarmed. */
  onPick: (meta: UiContextMeta) => void;
  /**
   * Mirrors whether the overlay is up: `true` once it has mounted, `false` once
   * it is gone — after a pick, a cancel, or the picker unmounting mid-pick. For
   * a host that must change around the pick (a popover that hides while the
   * whole page is pickable).
   */
  onArmedChange?: (armed: boolean) => void;
  /**
   * The instruction shown at the bottom of the screen while armed, beside
   * "Esc" and a Cancel button. Omitted, the overlay shows no pill at all.
   */
  hint?: string;
  /** The control that arms the picker. `armed` is true while the overlay is up. */
  trigger: (state: { armed: boolean; arm: () => void }) => ReactNode;
}

/**
 * "Point at an element, get its `<ui-context>` metadata" — the trigger the
 * caller renders, and the inspector overlay it arms.
 *
 * A component rather than a hook handing back an overlay to render: that pair
 * is easy to get half-wrong (arm it, forget to mount the overlay), and here
 * there is nothing to forget.
 *
 * Esc and the hint's Cancel button share one cancel path; a pick disarms before
 * `onPick` runs, so the host sees the overlay already on its way out.
 */
export function ElementPicker({
  onPick,
  onArmedChange,
  hint,
  trigger,
}: ElementPickerProps) {
  const [armed, setArmed] = useState(false);

  // Keyed on `armed`, so ONE statement covers every way out — a pick, a cancel,
  // and this component unmounting while armed, which no handler would see.
  const reportArmed = useEventCallback((next: boolean) =>
    onArmedChange?.(next),
  );
  useEffect(() => {
    if (!armed) return;
    reportArmed(true);
    return () => reportArmed(false);
  }, [armed, reportArmed]);

  // A ⌘-click passes through to the app (see PickerOverlay) and so lands
  // outside a popover the picker was armed from — the task-draft form's own
  // picker — which would close it, and the picker along with its content.
  useHoldPopoverOpen(armed);

  return (
    <>
      {trigger({ armed, arm: () => setArmed(true) })}
      {armed && (
        <PickerOverlay
          hint={hint}
          onPick={(el) => {
            // Read the element before anything re-renders around it.
            const meta = collectMeta(el);
            setArmed(false);
            onPick(meta);
          }}
          onCancel={() => setArmed(false)}
        />
      )}
    </>
  );
}
