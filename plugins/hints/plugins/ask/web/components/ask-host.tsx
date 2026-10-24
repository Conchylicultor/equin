import { useRef, useState } from "react";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  Placed,
  type Extent,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { useDragGesture } from "@plugins/primitives/plugins/dom/plugins/movable/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import {
  DEFAULT_ASK_POSITION,
  placeAfterDrag,
  type AskPosition,
} from "../../core";
import { restoreCard, useAskState } from "../internal/ask-store";
import { askPositionStore } from "../internal/stores";
import { useRestoreNewestRun } from "../internal/use-ask";
import { AskEmptyCard, AskThreadCard } from "./ask-card";
import { AskPill } from "./ask-pill";

/**
 * At most this much of the card may leave the viewport when the window
 * shrinks under a stored position: the anchor offset is capped so the card's
 * near edge stays this far inside the far edge.
 */
const KEEP_VISIBLE = "8rem";

interface Shift {
  dx: number;
  dy: number;
}

/** One axis of the stored position, as a `Placed` extent (plus a live drag offset). */
function extentOf(
  edge: "left" | "right" | "top" | "bottom",
  offset: number,
  shift: number,
): Extent {
  const at = `min(${offset}px, calc(100% - ${KEEP_VISIBLE}))`;
  return edge === "left" || edge === "top"
    ? { start: at, shift }
    : { end: at, shift };
}

/**
 * The one Ask equin host, at `Core.Root` — above every tab, so the card (or
 * its pill) stays put while the user moves between apps. It restores the
 * newest run once per load, and places the card where the user left it
 * (`askPositionStore`): dragged by its header, free, snapping only when
 * dropped near a corner (`placeAfterDrag`). The pill sits where the card was.
 * In the chrome's fixed theme, so it looks the same over every app.
 */
export function AskHost() {
  useRestoreNewestRun();
  const { mode, conversationId, fresh } = useAskState();
  const [position, setPosition] = useDraft<AskPosition>(
    askPositionStore,
    DEFAULT_ASK_POSITION,
  );
  const [shift, setShift] = useState<Shift | null>(null);
  const boxRef = useRef<HTMLElement | null>(null);
  const startRect = useRef<DOMRect | null>(null);
  const lastShift = useRef<Shift>({ dx: 0, dy: 0 });

  const drag = useDragGesture({
    onStart: () => {
      const box = boxRef.current;
      if (!box)
        throw new Error("[hints.ask] drag started with no card mounted");
      startRect.current = box.getBoundingClientRect();
      lastShift.current = { dx: 0, dy: 0 };
    },
    onMove: ({ dx, dy }) => {
      lastShift.current = { dx, dy };
      setShift({ dx, dy });
    },
    onEnd: () => {
      const r = startRect.current;
      if (!r) throw new Error("[hints.ask] drag ended without a start");
      const { dx, dy } = lastShift.current;
      setPosition(
        placeAfterDrag(
          {
            left: r.left + dx,
            top: r.top + dy,
            width: r.width,
            height: r.height,
          },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
      setShift(null);
      startRect.current = null;
    },
  });

  if (mode === "closed") return null;
  const card = () => {
    const box = boxRef.current;
    if (!box) throw new Error("[hints.ask] the card is not mounted");
    return box;
  };
  return (
    <ViewportOverlay layer="popover" className="pointer-events-none">
      <Theme name={chromeThemeScope} surface="none">
        <Placed
          ref={boxRef}
          x={extentOf(position.h, position.hx, shift?.dx ?? 0)}
          y={extentOf(position.v, position.vy, shift?.dy ?? 0)}
          className="pointer-events-auto"
        >
          {mode === "min" && conversationId !== null ? (
            <AskPill conversationId={conversationId} onOpen={restoreCard} />
          ) : conversationId !== null ? (
            <AskThreadCard conversationId={conversationId} drag={drag} />
          ) : (
            <AskEmptyCard key={fresh} drag={drag} card={card} />
          )}
        </Placed>
      </Theme>
    </ViewportOverlay>
  );
}
