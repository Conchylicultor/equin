import { useMemo, type ReactNode } from "react";
import { FloatingSurface } from "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";
import type { HintPlacement } from "../../core";
import {
  ANCHOR_PADDING,
  inflate,
  rectOf,
  type HintRect,
} from "../internal/rect";

/**
 * A hint card floating beside its anchor element: Floating UI places it
 * (flip + scroll-follow) and it never takes focus, so the anchor stays usable.
 * The anchor is virtual — the element's live rect plus the padding the
 * spotlight leaves — and `rect` (the host's tracked copy) re-runs the
 * placement when the element moves for a reason Floating UI cannot see.
 */
export function AnchoredCard({
  element,
  rect,
  placement = "bottom",
  children,
}: {
  element: HTMLElement;
  rect: HintRect;
  placement?: HintPlacement;
  children: ReactNode;
}) {
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => {
        const r = inflate(rectOf(element), ANCHOR_PADDING);
        return new DOMRect(r.x, r.y, r.width, r.height);
      },
      contextElement: element,
    }),
    [element],
  );
  return (
    <FloatingSurface
      open
      anchor={anchor}
      side={placement}
      align="center"
      sideOffset={8}
      width="xl"
      padding="md"
      reposition={rect}
    >
      {children}
    </FloatingSurface>
  );
}
