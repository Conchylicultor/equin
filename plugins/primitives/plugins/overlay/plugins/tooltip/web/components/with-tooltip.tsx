import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactElement, ReactNode } from "react";

import { usePinOnClick } from "./use-pin-on-click";

export interface WithTooltipProps {
  /**
   * A short label (or a `TooltipDoc`). Something described in parts — a
   * title with an id, chips, a footer — is a hover card
   * (`overlay/hover-card`), which owns that layout and its width.
   */
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /**
   * A click on the trigger pins the tooltip open (and a second click unpins
   * it), on top of the usual hover. For a trigger whose tooltip IS its content
   * — a status mark with nothing else to do on click — so the click that
   * people try first shows it, and it stays up while they read. A click
   * elsewhere or Esc closes it.
   */
  pinOnClick?: boolean;
  children: ReactElement;
}

export function WithTooltip({
  content,
  side,
  pinOnClick = false,
  children,
}: WithTooltipProps) {
  const pin = usePinOnClick();
  return (
    <Tooltip {...(pinOnClick ? pin.root : {})}>
      <TooltipTrigger render={children} {...(pinOnClick ? pin.trigger : {})} />
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}
