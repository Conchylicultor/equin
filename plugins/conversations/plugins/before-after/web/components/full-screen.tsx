import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { ColorSchemeRegion } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import type { BeforeAfterPair } from "../../core";
import { useCompareState } from "../internal/compare-state";
import { PairViewer } from "./pair-viewer";
import { steppedPair } from "../internal/step";

const closeIcon = symbol("close");
const prevIcon = symbol("chevron-left");
const nextIcon = symbol("chevron-right");

/**
 * The pane's viewer over the whole window, dark like the image viewer (the
 * screenshots are the content; the chrome recedes): the same comparison —
 * mode and divider are the pane's — with ← / → (or the side buttons) stepping
 * through the conversation's pairs, wrapping, and Esc or × closing. A step
 * selects the pair in the pane too, so closing lands on the one last shown.
 *
 * Every key is kept here (the image viewer's rule): an app shortcut must not
 * also fire while the view has focus. A key the swipe divider answers (←/→
 * while it is focused) is the divider's — it stops it first.
 */
export function FullScreenCompare({
  pair,
  pairs,
  onSelect,
}: {
  pair: BeforeAfterPair;
  pairs: readonly BeforeAfterPair[];
  onSelect: (id: string) => void;
}): ReactNode {
  const { setFullScreen } = useCompareState();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Moved for the user (the view just opened), so it reveals nothing.
    focusElement(rootRef.current, { reveal: false });
  }, []);
  const close = () => setFullScreen(false);
  const step = (by: 1 | -1) => {
    const next = steppedPair(pairs, pair.id, by);
    if (next !== undefined && next.id !== pair.id) onSelect(next.id);
  };
  const several = pairs.length > 1;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    }
  };
  return (
    <ViewportOverlay
      role="dialog"
      aria-modal="true"
      aria-label={`Before / after — ${pair.title}`}
    >
      <ColorSchemeRegion
        as={Layer}
        scheme="dark"
        ref={rootRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="bg-background text-foreground outline-none"
      >
        <Inset x="lg" t="md" b="lg" className="size-full">
          <PairViewer
            pair={pair}
            titled
            className="size-full"
            stageClassName={several ? cn("px-2xl") : undefined}
            trailing={
              <IconButton
                icon={closeIcon}
                label="Close (Esc)"
                onClick={close}
              />
            }
          />
        </Inset>
        {several ? (
          <>
            <Pin to="left" offset="md" layer="raised">
              <IconButton
                icon={prevIcon}
                label="Previous (←)"
                variant="secondary"
                className="rounded-full"
                onClick={() => step(-1)}
              />
            </Pin>
            <Pin to="right" offset="md" layer="raised">
              <IconButton
                icon={nextIcon}
                label="Next (→)"
                variant="secondary"
                className="rounded-full"
                onClick={() => step(1)}
              />
            </Pin>
          </>
        ) : null}
      </ColorSchemeRegion>
    </ViewportOverlay>
  );
}
