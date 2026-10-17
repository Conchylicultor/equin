import { useState } from "react";

/**
 * Click-to-pin for a ui-kit `Tooltip`: a click on the trigger pins it open
 * (and a second click unpins it), on top of the usual hover and focus. A
 * click elsewhere or Esc closes it. Spread `root` on the `Tooltip` and
 * `trigger` on its `TooltipTrigger` — both, or neither when not pinning.
 *
 * For a trigger whose tooltip IS its content — a status mark with nothing else
 * to do on click — so the click that people try first shows it, and it stays
 * up while they read.
 */
export function usePinOnClick() {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Hover is tracked on the trigger itself: once the popup is held open by
  // the controlled `open`, base-ui stops reporting a later hover-in, so hover
  // would never reopen it after a pinned close. base-ui still owns focus and
  // the dismissals (Esc, a click elsewhere), which unpin.
  return {
    root: {
      open: pinned || hovered || focused,
      onOpenChange: (open: boolean, { reason }: { reason: string }) => {
        if (reason === "outside-press" || reason === "escape-key") {
          setPinned(false);
          setHovered(false);
          setFocused(false);
        } else if (reason === "trigger-focus") setFocused(open);
      },
    },
    trigger: {
      closeOnClick: false,
      onClick: () => {
        // Unpinning closes it even under the pointer: the click said "away".
        if (pinned) setHovered(false);
        setPinned(!pinned);
      },
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => setHovered(false),
    },
  };
}
