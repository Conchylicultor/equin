import type { ReactElement } from "react";
import { AdaptiveBar } from "@plugins/primitives/plugins/adaptive-bar/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { hoverRevealTargetInAnchor } from "@plugins/primitives/plugins/hover-reveal/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { CanvasFrame } from "../internal/canvas-model";
import { PrototypeFrameActions, type FrameResolution } from "../slots";
import { usePrototypeDetail } from "../context";
import { FrameShowsBox } from "./frame-box";

/** The header row's own height, px (the frame box inside it is 28px). */
export const FRAME_HEADER_HEIGHT = 26;

/**
 * A frame's header (the mockup's `.fhead`): what it shows on the left (ONE
 * box, `FrameShowsBox` — a presentation's tag is the same box) — and its actions on
 * the right, revealed while the frame is hovered. One line at a fixed height,
 * so the canvas can subtract it from the room a frame's screen gets.
 *
 * The header is exactly as wide as the frame's screen, which on a crowded
 * canvas is narrow — so it is an adaptive bar: the actions that do not fit move
 * behind a `⋯`, and the box shrinks late to its narrow form (no `+N`, no age,
 * no chip chevron). The actions stay hidden until the frame (the nearest
 * hover-reveal anchor) is hovered, but only while they sit in the row — one
 * relocated into the `⋯` panel is shown there as itself.
 */
export function FrameHeader({
  frame,
  meta,
  name,
  resolution,
}: {
  frame: CanvasFrame;
  meta: PrototypeMeta;
  /** The frame's name ("Mist · Home", "Real app"). */
  name: string;
  /** What a source frame resolved to — `null` for a prototype frame. */
  resolution: FrameResolution | null;
}): ReactElement {
  const { dispatch } = usePrototypeDetail();
  const row = { frame, meta };
  return (
    <ControlSizeProvider size="xs">
      <Line style={{ height: FRAME_HEADER_HEIGHT }}>
        <AdaptiveBar gap="sm" label="Frame actions">
          <AdaptiveBar.Item id="shows">
            <FrameShowsBox
              frame={frame}
              meta={meta}
              name={name}
              resolution={resolution}
              compare={(version) =>
                dispatch({ type: "addPrototype", from: frame.id, version })
              }
            />
          </AdaptiveBar.Item>
          <Fill />
          <PrototypeFrameActions.Render>
            {(item) => {
              const Action = item.component;
              return (
                <AdaptiveBar.Item
                  id={item.id}
                  className={hoverRevealTargetInAnchor}
                >
                  <Action row={row} hasChildren={false} />
                </AdaptiveBar.Item>
              );
            }}
          </PrototypeFrameActions.Render>
        </AdaptiveBar>
      </Line>
    </ControlSizeProvider>
  );
}
