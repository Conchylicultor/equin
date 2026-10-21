import type { ReactElement, ReactNode } from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { PortalHost } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  CANVAS_FRAME_ATTR,
  CANVAS_FRAME_KIND_ATTR,
  CANVAS_FRAME_STATUS_ATTR,
  PROTOTYPE_FRAME_KIND,
  type CanvasFrameStatus,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import type {
  CanvasFrame,
  PrototypeFrame as PrototypeFrameModel,
  SourceFrame,
} from "../internal/canvas-model";
import type { FrameLayout } from "../internal/layout";
import type { PageExtent } from "../internal/page-extent";
import { FrameSource, type FrameResolution } from "../slots";
import { useFrameColorVars, useFrameSrc, usePrototypeDetail } from "../context";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { CanvasSize } from "../internal/canvas-model";
import { GEOMETRY_MOTION } from "../internal/geometry-motion";
import { PrototypeFrame } from "./prototype-frame";

/** Everything the frame view is sized by, and the letter it publishes. */
export interface CanvasFrameViewProps {
  frame: CanvasFrame;
  meta: PrototypeMeta;
  /** The canvas-wide logical size and scale (`layoutFrames`). */
  layout: FrameLayout;
  /** The frame's letter, published for drivers (`data-canvas-frame`). */
  letter: string;
  wholePage?: boolean;
  /** This document's measured full height, when Whole page is on. */
  pageHeight?: number | null;
  /** This frame's extent, when Whole page is on (see `PageExtent`). */
  onPageExtent?: (extent: PageExtent) => void;
  /**
   * Draw the screen with no frame of its own — square, unringed, no drop — for
   * a surface where it IS the whole view (a full-screen presentation).
   * Default false: the canvas's framed screen.
   */
  bare?: boolean;
  /**
   * Wrap the screen in chrome that needs what a source frame resolved to (its
   * tag): the canvas's frame header, Present's hover tag. Defaults to the
   * screen alone. The resolution is `null` for a prototype frame.
   */
  children?: (
    screen: ReactNode,
    resolution: FrameResolution | null,
  ) => ReactNode;
}

/**
 * One frame of the canvas: its screen — a box at the canvas's size and scale —
 * showing either the prototype (its version, under its picks) or what a frame
 * source resolved to. Exported so Present renders the very same frame.
 */
export function CanvasFrameView(props: CanvasFrameViewProps): ReactElement {
  return props.frame.kind === "prototype" ? (
    <PrototypeFrameView {...props} frame={props.frame} />
  ) : (
    <SourceFrameView {...props} frame={props.frame} />
  );
}

function PrototypeFrameView({
  frame,
  meta,
  layout,
  letter,
  wholePage = false,
  pageHeight = null,
  onPageExtent = ignoreExtent,
  bare = false,
  children = justScreen,
}: CanvasFrameViewProps & { frame: PrototypeFrameModel }): ReactElement {
  const src = useFrameSrc(frame, meta);
  const colorVars = useFrameColorVars(frame, meta);
  const screen = (
    <Screen
      layout={layout}
      letter={letter}
      kind={PROTOTYPE_FRAME_KIND}
      status="found"
      bare={bare}
    >
      <PrototypeFrame
        src={src}
        title={meta.title}
        width={layout.width}
        height={layout.height}
        scale={layout.scale}
        wholePage={wholePage}
        pageHeight={pageHeight}
        colorVars={colorVars}
        onPageExtent={onPageExtent}
      />
    </Screen>
  );
  return <>{children(screen, null)}</>;
}

function SourceFrameView({
  frame,
  meta,
  layout,
  letter,
  bare = false,
  children = justScreen,
}: CanvasFrameViewProps & { frame: SourceFrame }): ReactElement {
  return (
    <FrameSource.Dispatch source={frame.source} meta={meta}>
      {(resolution) =>
        children(
          <Screen
            layout={layout}
            letter={letter}
            kind={frame.source}
            status={resolution.status}
            bare={bare}
          >
            <SourceBody resolution={resolution} layout={layout} />
          </Screen>,
          resolution,
        )
      }
    </FrameSource.Dispatch>
  );
}

/** A frame source's answer, painted inside the screen. */
function SourceBody({
  resolution,
  layout,
}: {
  resolution: FrameResolution;
  layout: FrameLayout;
}): ReactElement {
  switch (resolution.status) {
    case "loading":
      return (
        <Inset pad="lg">
          <Loading label={resolution.label ?? "Loading…"} />
        </Inset>
      );
    case "unresolved":
      // Prose, not a rendering: it reflows inside the screen instead of zooming.
      return (
        <Inset pad="lg">
          <Stack gap="sm">
            <Text variant="body">{resolution.title}</Text>
            {typeof resolution.detail === "string" ? (
              <Text variant="body" tone="muted">
                {resolution.detail}
              </Text>
            ) : (
              resolution.detail
            )}
          </Stack>
        </Inset>
      );
    case "found":
      return (
        // One crashing source costs its own frame, not the canvas.
        <PluginErrorBoundary
          slot="prototype-canvas-frame"
          label={resolution.tag}
        >
          <div
            // Laid out at the logical size, then scaled like a prototype frame.
            className="relative"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${String(layout.scale)})`,
              transformOrigin: "top left",
            }}
          >
            {/* A source renders in this document, so its popups would portal
                to <body> — over the whole canvas, unscaled, escaping the
                screen's clip and the swipe divider. Drawn inside the frame
                instead, they belong to it as an iframe's would. */}
            <PortalHost>
              {resolution.render(layout.width, layout.height)}
            </PortalHost>
          </div>
        </PluginErrorBoundary>
      );
  }
}

/**
 * A framed screen's corners: a device's own (a phone's deep curve, a
 * tablet's), else the canvas frame's `rounded-xl`.
 */
function frameCorners(size: CanvasSize): string {
  if (size.kind === "preset" && size.preset === "Phone") return "rounded-4xl";
  if (size.kind === "preset" && size.preset === "Tablet") return "rounded-3xl";
  return "rounded-xl";
}

/**
 * The screen box: the canvas's size at its scale, clipping what it shows —
 * framed (the size's corners, a hairline ring and the frame's deep drop) or
 * `bare`. Its size and corners glide with the layout (`GEOMETRY_MOTION`), in
 * step with the frame box around it. The box a driver photographs
 * (`data-canvas-frame*`).
 */
function Screen({
  layout,
  letter,
  kind,
  status,
  bare,
  children,
}: {
  layout: FrameLayout;
  letter: string;
  kind: string;
  status: CanvasFrameStatus;
  bare: boolean;
  children: ReactNode;
}): ReactElement {
  const { canvas } = usePrototypeDetail();
  return (
    <div
      className={cn(
        "relative bg-background",
        GEOMETRY_MOTION,
        !bare && [frameCorners(canvas.size), "shadow-2xl ring-1 ring-border"],
      )}
      style={{
        width: layout.width * layout.scale,
        height: layout.visibleHeight * layout.scale,
        overflow: "hidden",
      }}
      {...{
        [CANVAS_FRAME_ATTR]: letter,
        [CANVAS_FRAME_KIND_ATTR]: kind,
        [CANVAS_FRAME_STATUS_ATTR]: status,
      }}
    >
      {children}
    </div>
  );
}

function justScreen(screen: ReactNode): ReactNode {
  return screen;
}

function ignoreExtent(): void {}
