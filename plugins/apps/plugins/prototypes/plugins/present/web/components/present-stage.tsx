import { useState, type ReactElement, type ReactNode } from "react";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { hoverRevealTarget } from "@plugins/primitives/plugins/hover-reveal/web";
import { Movable } from "@plugins/primitives/plugins/dom/plugins/movable/web";
import {
  prototypesList,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  CanvasFrameView,
  OptionsPill,
  SizeChip,
  VersionStepper,
  frameA,
  layoutFrames,
  useWindowSize,
  letterOf,
  useFrameNames,
  usePrototypeDetail,
  type CanvasFrame,
  type FrameId,
  type FrameResolution,
  pageHeightOf,
  sameExtent,
  type PageExtent,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { PRESENT_CHROME_ATTR } from "../internal/use-pointer-idle";
import { useChromeIdle, usePresentRoot } from "./present-box";

/** The Exit button, and which top corner it takes. */
export interface PresentExit {
  onExit: () => void;
  /**
   * `left` puts it beside the tag, top-left — for a presentation that leaves
   * the app's floating chrome (the global action bar, top-right) above it.
   */
  side: "left" | "right";
}

/**
 * What every presentation shows — the in-app overlays and the new-tab page
 * alike: ONE canvas frame, sized by the canvas-wide size, zoom and Whole page
 * computed for the room the presentation has (so "Phone at Fit" is a phone
 * filling the screen, "Responsive at Fit" the page at the screen's own width).
 *
 * Hovering shows the chrome: the frame's tag (name, version stepper,
 * and "i of n · ← →" when there are more frames), Exit, the options pill
 * (bottom centre) and the size & zoom chip (bottom right). Each piece can be
 * dragged off what it covers in the frame (double-click its surface to send it
 * home).
 */
export function PresentStage({
  name,
  frameId,
  exit,
}: {
  name: string;
  /** The frame on show — frame A when absent or gone. */
  frameId?: FrameId;
  /** Absent on the new-tab page: closing the tab is how you leave. */
  exit?: PresentExit;
}): ReactNode {
  return matchResource(useLive(prototypesList), {
    loading: () => <Loading variant="block" />,
    ready: (rows) => {
      const meta = rows.find((p) => p.name === name) ?? null;
      if (!meta) {
        return (
          <Text as="div" variant="body" tone="muted" className="p-lg">
            Prototype not found.
          </Text>
        );
      }
      return <PresentedFrame meta={meta} frameId={frameId} exit={exit} />;
    },
  });
}

function PresentedFrame({
  meta,
  frameId,
  exit,
}: {
  meta: PrototypeMeta;
  frameId: FrameId | undefined;
  exit: PresentExit | undefined;
}): ReactElement {
  const { canvas } = usePrototypeDetail();
  const idle = useChromeIdle();
  const root = usePresentRoot();
  const [roomRef, room] = useElementSize<HTMLDivElement>();
  const browserWindow = useWindowSize();
  // The shown frame's extent, for Whole page. Keyed by frame so flipping to
  // another frame never fits it to the previous one's page.
  const [page, setPage] = useState<{ id: FrameId; extent: PageExtent } | null>(
    null,
  );
  const frame: CanvasFrame | null =
    canvas.frames.find((f) => f.id === frameId) ?? frameA(canvas.frames);
  if (frame === null) {
    return (
      <Text as="div" variant="body" tone="muted" className="p-lg">
        Nothing to present.
      </Text>
    );
  }
  const index = canvas.frames.indexOf(frame);
  // Every piece of chrome: revealed by hovering the box, and hidden again while
  // the pointer rests over the frame (see `PresentBox`).
  const chrome = {
    [PRESENT_CHROME_ATTR]: "",
    className: idle ? CHROME_RESTING : hoverRevealTarget,
  };
  const extent = page?.id === frame.id ? page.extent : null;
  const pageHeight = pageHeightOf(extent);
  const noWholePage = canvas.wholePage && extent?.kind === "window-sized";
  const layout = layoutFrames({
    room: { w: Math.max(1, room.width), h: Math.max(1, room.height) },
    size: canvas.size,
    browserWindow,
    zoom: canvas.zoom,
    wholePage: canvas.wholePage,
    pageHeight,
  });

  return (
    <CanvasFrameView
      frame={frame}
      meta={meta}
      layout={layout}
      letter={letterOf(index)}
      wholePage={canvas.wholePage}
      pageHeight={pageHeight}
      onPageExtent={(next) =>
        setPage((prev) =>
          prev?.id === frame.id && sameExtent(prev.extent, next)
            ? prev
            : { id: frame.id, extent: next },
        )
      }
    >
      {(screen, resolution) => (
        <>
          {/* Bigger than the room (a zoom past Fit, a tall Whole page): it
              scrolls. Otherwise centred by auto margins, which — unlike
              `justify-content: center` — never clip the overflowing side. */}
          <Scroll ref={roomRef} axis="both" className="size-full">
            {room.width > 0 ? (
              <Stack
                direction="row"
                gap="none"
                style={{ minWidth: "max-content", minHeight: "100%" }}
              >
                <div style={{ margin: "auto" }}>{screen}</div>
              </Stack>
            ) : null}
          </Scroll>
          <Pin to="top-left" offset="md" {...chrome}>
            <Movable bounds={root}>
            <Stack direction="row" gap="sm" align="center">
              <FrameTag
                frame={frame}
                index={index}
                count={canvas.frames.length}
                meta={meta}
                resolution={resolution}
              />
              {exit?.side === "left" ? (
                <ExitButton onExit={exit.onExit} />
              ) : null}
            </Stack>
            </Movable>
          </Pin>
          {exit?.side === "right" ? (
            <Pin to="top-right" offset="md" {...chrome}>
              <Movable bounds={root}>
                <ExitButton onExit={exit.onExit} />
              </Movable>
            </Pin>
          ) : null}
          {frame.kind === "prototype" ? (
            <Pin to="bottom" offset="lg" {...chrome}>
              <Movable bounds={root}>
                <OptionsPill frame={frame} meta={meta} />
              </Movable>
            </Pin>
          ) : null}
          <Pin to="bottom-right" offset="md" {...chrome}>
            <Movable bounds={root}>
              <SizeChip layout={layout} noWholePage={noWholePage} />
            </Movable>
          </Pin>
        </>
      )}
    </CanvasFrameView>
  );
}

/**
 * Chrome resting out of sight: faded out, and never a live click-target while
 * hidden — the same coupling `hoverRevealTarget` keeps.
 */
const CHROME_RESTING =
  "opacity-0 pointer-events-none select-none transition-opacity duration-400";

/** The frame tag's card look (the Exit button beside it is `variant="floating"`). */
const CHROME = "rounded-md border border-border bg-background shadow-md";

/**
 * The frame's tag: its name, what it shows (the version stepper for
 * the prototype, the source's tag otherwise), and — with more than one frame —
 * where it sits among them and the keys that flip through them.
 */
function FrameTag({
  frame,
  index,
  count,
  meta,
  resolution,
}: {
  frame: CanvasFrame;
  index: number;
  count: number;
  meta: PrototypeMeta;
  resolution: FrameResolution | null;
}): ReactElement {
  const { dispatch } = usePrototypeDetail();
  const names = useFrameNames(meta);
  return (
    <ControlSizeProvider size="xs">
      <Stack
        direction="row"
        gap="sm"
        align="center"
        className={cn(CHROME, "h-8 pl-xs pr-2xs")}
      >
        <Text variant="label" className="whitespace-nowrap">
          {names(frame)}
        </Text>
        {frame.kind === "prototype" ? (
          <VersionStepper
            name={meta.name}
            shown={frame.version}
            show={(version) =>
              dispatch({ type: "setVersion", id: frame.id, version })
            }
          />
        ) : resolution?.status === "found" ? (
          <Badge variant="success">{resolution.tag}</Badge>
        ) : null}
        {count > 1 ? (
          <Text
            variant="caption"
            tone="faint"
            className="whitespace-nowrap pr-xs"
          >
            {index + 1} of {count} · ← →
          </Text>
        ) : null}
      </Stack>
    </ControlSizeProvider>
  );
}

function ExitButton({ onExit }: { onExit: () => void }): ReactElement {
  return (
    <Button
      variant="floating"
      className="rounded-md"
      aria-label="Exit presentation (Esc)"
      onClick={onExit}
    >
      Exit
      <Kbd>Esc</Kbd>
    </Button>
  );
}
