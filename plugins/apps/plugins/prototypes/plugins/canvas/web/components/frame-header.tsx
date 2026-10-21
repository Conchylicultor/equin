import type { ReactElement } from "react";
import { AdaptiveBar } from "@plugins/primitives/plugins/adaptive-bar/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { hoverRevealTargetInAnchor } from "@plugins/primitives/plugins/hover-reveal/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { CanvasFrame } from "../internal/canvas-model";
import { FRAME_HEAD } from "../internal/layout";
import { PrototypeFrameActions, type FrameResolution } from "../slots";
import { usePrototypeDetail } from "../context";
import { VersionStepper } from "./version-stepper";

/** The header row's own height; the gap under it makes up `FRAME_HEAD`. */
export const FRAME_HEADER_HEIGHT = 26;
export const FRAME_HEADER_GAP = FRAME_HEAD - FRAME_HEADER_HEIGHT;

/**
 * A frame's header: its name, what it shows (the version stepper for
 * the prototype, the source's tag otherwise), and its actions. One line at a
 * fixed height, so the canvas can subtract it from the room a frame's screen
 * gets.
 *
 * The header is exactly as wide as the frame's screen, which on a crowded
 * canvas is narrow — so it is an adaptive bar: the name ellipsizes down to its
 * floor, the stepper shrinks to its bare label, and the actions that still do
 * not fit move behind a `⋯`. The actions stay hidden until the frame (the
 * nearest hover-reveal anchor) is hovered, but only while they sit in the row —
 * one relocated into the `⋯` panel is shown there as itself, and a header
 * outside any anchor (the swipe layout's) shows them always.
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
  const row = { frame, meta };
  return (
    <ControlSizeProvider size="xs">
      <Line style={{ height: FRAME_HEADER_HEIGHT }}>
        <AdaptiveBar gap="sm" label="Frame actions">
          <AdaptiveBar.Yield>
            <Text variant="label">{name}</Text>
          </AdaptiveBar.Yield>
          <AdaptiveBar.Item id="shows">
            {frame.kind === "prototype" ? (
              <FrameVersion frame={frame} name={meta.name} />
            ) : resolution?.status === "found" ? (
              <Badge variant="success">{resolution.tag}</Badge>
            ) : null}
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

/** A prototype frame's own version stepper. */
function FrameVersion({
  frame,
  name,
}: {
  frame: Extract<CanvasFrame, { kind: "prototype" }>;
  name: string;
}): ReactElement {
  const { dispatch } = usePrototypeDetail();
  return (
    <VersionStepper
      name={name}
      shown={frame.version}
      show={(version) =>
        dispatch({ type: "setVersion", id: frame.id, version })
      }
      compare={(version) =>
        dispatch({ type: "addPrototype", from: frame.id, version })
      }
    />
  );
}
