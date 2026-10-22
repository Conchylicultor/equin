import { useState, type ReactElement, type ReactNode } from "react";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Movable } from "@plugins/primitives/plugins/dom/plugins/movable/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  prototypeDetailRoute,
  prototypesApp,
} from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import {
  prototypesList,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  AddFrameRail,
  CanvasFrameView,
  FrameShowsBox,
  SizeChip,
  frameA,
  layoutFrames,
  useWindowSize,
  letterOf,
  useFrameNames,
  usePrototypeDetail,
  canvasWith,
  openCanvasInApp,
  type CanvasAddAction,
  type CanvasFrame,
  type FrameId,
  type FrameResolution,
  pageHeightOf,
  sameExtent,
  type PageExtent,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { usePresentChrome, usePresentRoot } from "./present-box";

/**
 * What every presentation shows — the in-app overlays and the new-tab page
 * alike: ONE canvas frame, sized by the canvas-wide size, zoom and Whole page
 * computed for the room the presentation has (so "Phone at Fit" is a phone
 * filling the screen, "Responsive at Fit" the page at the screen's own width).
 *
 * Hovering shows the chrome: the frame's tag (the canvas frame header's own
 * box — options chip | version stepper — and "i of n · ← →" when there are
 * more frames), Exit and the size & zoom chip (bottom right). Each piece can be
 * dragged off what it covers in the frame (double-click its surface to send it
 * home).
 */
export function PresentStage({
  name,
  frameId,
  onExit,
  onExtend,
  onFlip,
}: {
  name: string;
  /** The frame on show — frame A when absent or gone. */
  frameId?: FrameId;
  /**
   * The overlay's Exit (top-right). Absent on the new-tab page, which instead
   * offers Exit back to the prototype's canvas (at the start of the tag's pill).
   */
  onExit?: () => void;
  /**
   * What the right edge's `+` / Compare do. Absent on the new-tab page, where
   * each opens the prototype's canvas in the full app on the canvas the action
   * leads to; an overlay applies the action to the live canvas and leaves.
   */
  onExtend?: (action: CanvasAddAction) => void;
  /**
   * Show the previous (-1) or next (1) frame — what the tag's ‹ › and the
   * arrow keys do. Absent on the new-tab page, which has one frame.
   */
  onFlip?: (delta: -1 | 1) => void;
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
      return (
        <PresentedFrame
          meta={meta}
          frameId={frameId}
          onExit={onExit}
          onExtend={onExtend}
          onFlip={onFlip}
        />
      );
    },
  });
}

function PresentedFrame({
  meta,
  frameId,
  onExit,
  onExtend,
  onFlip,
}: {
  meta: PrototypeMeta;
  frameId: FrameId | undefined;
  onExit: (() => void) | undefined;
  onExtend: ((action: CanvasAddAction) => void) | undefined;
  onFlip: ((delta: -1 | 1) => void) | undefined;
}): ReactElement {
  const { canvas } = usePrototypeDetail();
  const chrome = usePresentChrome();
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
      bare
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
          <Movable at={{ pin: "top", offset: "md" }} bounds={root} {...chrome}>
            <FrameTag
              frame={frame}
              index={index}
              count={canvas.frames.length}
              meta={meta}
              resolution={resolution}
              onFlip={onFlip}
              onExtend={onExtend}
              leading={
                onExit === undefined ? (
                  <LeaveToCanvasButton name={meta.name} />
                ) : undefined
              }
            />
          </Movable>
          {frame.kind === "prototype" ? (
            <Pin to="right" offset="md" {...chrome}>
              <ExtendActions meta={meta} onExtend={onExtend} />
            </Pin>
          ) : null}
          {onExit !== undefined ? (
            <Movable
              at={{ pin: "top-right", offset: "md" }}
              bounds={root}
              {...chrome}
            >
              <ExitButton onExit={onExit} />
            </Movable>
          ) : null}
          <Movable
            at={{ pin: "bottom-right", offset: "md" }}
            bounds={root}
            {...chrome}
          >
            <SizeChip layout={layout} noWholePage={noWholePage} />
          </Movable>
        </>
      )}
    </CanvasFrameView>
  );
}

/**
 * The frame's tag: the very box the canvas's frame header shows
 * (`FrameShowsBox` — the options chip | the version stepper, or the source's
 * name), floated, with — when there are more frames — where this one sits
 * among them and the keys that flip through them.
 */
function FrameTag({
  frame,
  index,
  count,
  meta,
  resolution,
  onFlip,
  onExtend,
  leading,
}: {
  frame: CanvasFrame;
  index: number;
  count: number;
  meta: PrototypeMeta;
  resolution: FrameResolution | null;
  /** Flip to the previous / next frame (the ‹ › beside "i of n"). */
  onFlip: ((delta: -1 | 1) => void) | undefined;
  /** The overlay's way to add a frame — the version list's Compare. */
  onExtend: ((action: CanvasAddAction) => void) | undefined;
  /** A control at the pill's start (the present page's Exit). */
  leading?: ReactNode;
}): ReactElement {
  const names = useFrameNames(meta);
  return (
    <ControlSizeProvider size="xs">
      <FrameShowsBox
        frame={frame}
        meta={meta}
        name={names(frame)}
        resolution={resolution}
        compare={
          onExtend === undefined
            ? undefined
            : (version) =>
                onExtend({ type: "addPrototype", from: frame.id, version })
        }
        floating={{
          leading,
          trailing:
            count > 1 ? (
              <Stack direction="row" gap="none" align="center">
                <Text
                  variant="caption"
                  tone="faint"
                  className={cn("whitespace-nowrap px-xs", onFlip && "pr-2xs")}
                >
                  {index + 1} of {count}
                </Text>
                {onFlip ? (
                  <>
                    <IconButton
                      icon={previousIcon}
                      label="Previous frame"
                      shortcut="ArrowLeft"
                      onClick={() => onFlip(-1)}
                    />
                    <IconButton
                      icon={nextIcon}
                      label="Next frame"
                      shortcut="ArrowRight"
                      onClick={() => onFlip(1)}
                    />
                  </>
                ) : null}
              </Stack>
            ) : undefined,
        }}
      />
    </ControlSizeProvider>
  );
}

/** Exit, on the glass the rest of the presentation's chrome floats on. */
function ExitButton({ onExit }: { onExit: () => void }): ReactElement {
  return (
    <Surface level="float">
      <Button
        variant="ghost"
        className="rounded-popover"
        aria-label="Exit presentation (Esc)"
        onClick={onExit}
      >
        Exit
        <Kbd>Esc</Kbd>
      </Button>
    </Surface>
  );
}

const exitIcon = symbol("fullscreen-exit");
const previousIcon = symbol("chevron-left");
const nextIcon = symbol("chevron-right");

/**
 * The new-tab page's Exit: back to the prototype's canvas in the full app — a
 * document load, not an in-app navigation, because this document was opened
 * chromeless and stays so for its lifetime (`embedMode` is read once).
 */
function LeaveToCanvasButton({ name }: { name: string }): ReactElement {
  return (
    <IconButton
      icon={exitIcon}
      label="Exit to the prototype's canvas"
      onClick={() =>
        window.location.assign(
          prototypeDetailRoute.link(prototypesApp, { name }),
        )
      }
    />
  );
}

/**
 * The canvas's add rail, as a presentation hands it its actions: either way the
 * comparison is made on the prototype's canvas in the app. An overlay
 * (`onExtend`) applies each to the live canvas and leaves. The new-tab page
 * opens the app's canvas on the frame plus the new one, in this tab — and only
 * a page reading the shared picks record (frame A's link) can: one carrying a
 * variant of its own would, as frame A of a canvas, have to write that variant
 * to the record.
 */
function ExtendActions({
  meta,
  onExtend,
}: {
  meta: PrototypeMeta;
  onExtend: ((action: CanvasAddAction) => void) | undefined;
}): ReactElement {
  const { canvas, shared } = usePrototypeDetail();
  const ownPicks =
    onExtend === undefined && frameA(canvas.frames)?.picks !== "shared";
  return (
    <AddFrameRail
      meta={meta}
      disabled={
        ownPicks
          ? "This page shows a variant of its own — open frame A to compare"
          : undefined
      }
      extend={(action) => ({
        onClick: () =>
          onExtend !== undefined
            ? onExtend(action)
            : openCanvasInApp(meta.name, canvasWith(canvas, action, shared)),
      })}
    />
  );
}
