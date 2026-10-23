import type { ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  OverlayPanel,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";

/**
 * The welcome panel: the hint card's chrome at welcome width, standalone (no
 * anchor). The overlay below centers it; the exhibit shows it on its own.
 */
export function WelcomePanel({ children }: { children: ReactNode }) {
  return (
    <OverlayPanel width="2xl" padding="lg" scroll={false}>
      {children}
    </OverlayPanel>
  );
}

/**
 * A hint card centered in the viewport — the tour's welcome card (over a full
 * scrim, which takes the clicks: the intro is a choice to make first), or a
 * step with no anchor (no scrim, click-through around the card).
 */
export function CenteredCard({
  scrim,
  children,
}: {
  scrim: boolean;
  children: ReactNode;
}) {
  return (
    <ViewportOverlay
      className={cn(scrim ? "bg-black/45" : "pointer-events-none")}
    >
      <Center className="size-full">
        <div className="pointer-events-auto">
          <WelcomePanel>{children}</WelcomePanel>
        </div>
      </Center>
    </ViewportOverlay>
  );
}
