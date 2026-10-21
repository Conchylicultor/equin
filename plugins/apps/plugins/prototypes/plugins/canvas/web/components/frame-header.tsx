import type { ReactElement } from "react";
import { AdaptiveBar } from "@plugins/primitives/plugins/adaptive-bar/web";
import {
  ActionFormShield,
  useActionForm,
} from "@plugins/primitives/plugins/action-presentation/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ControlSizeProvider,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { hoverRevealTargetInAnchor } from "@plugins/primitives/plugins/hover-reveal/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypesIcons } from "@plugins/apps/plugins/prototypes/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  prototypeFrames,
  type CanvasFrame,
  type PrototypeFrame,
} from "../internal/canvas-model";
import { frameName, type NamedFrame } from "../internal/frame-name";
import { PrototypeFrameActions, type FrameResolution } from "../slots";
import {
  documentOptions,
  useFramePicks,
  usePrototypeDetail,
  useStoredPicksOf,
} from "../context";
import { OptionsChip } from "./options-pill";
import { VersionStepper } from "./version-stepper";

/** The header row's own height, px (the frame box inside it is 28px). */
export const FRAME_HEADER_HEIGHT = 26;

const appIcon = prototypesIcons.icon("app");

/**
 * A frame's header (the mockup's `.fhead`): what it shows on the left — for
 * the prototype, ONE box holding its options chip and its version stepper; for
 * a source frame, the dashed tag naming it ("Real app") — and its actions on
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
  const row = { frame, meta };
  return (
    <ControlSizeProvider size="xs">
      <Line style={{ height: FRAME_HEADER_HEIGHT }}>
        <AdaptiveBar gap="sm" label="Frame actions">
          <AdaptiveBar.Item id="shows">
            {frame.kind === "prototype" ? (
              <FrameBox frame={frame} meta={meta} name={name} />
            ) : (
              <SourceTag
                label={name}
                detail={resolution?.status === "found" ? resolution.tag : null}
              />
            )}
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

/**
 * A prototype frame's box (`.fbox`): its options chip | its version stepper,
 * on the card at 70% inside a 1px line. It gives up room late, after the
 * actions, since it is what a frame's header is for — and then only its
 * secondary labels (the narrow form).
 */
function FrameBox({
  frame,
  meta,
  name,
}: {
  frame: PrototypeFrame;
  meta: PrototypeMeta;
  name: string;
}): ReactElement {
  const narrow =
    useActionForm({ shrinksTo: ["compact"], yields: "late" }) === "compact";
  const named = useNamedCount(frame, meta);
  const picks = useFramePicks(frame, meta);
  const hasOptions = documentOptions(meta, frame.version).length > 0;
  // The box's ladder is its item's: the chip and the stepper are parts of it,
  // not occupants that each declare a form of their own.
  return (
    <ActionFormShield>
      <Line className="h-7 rounded-lg border border-border/64 bg-card/70 [--hover-fill:var(--accent)]">
        {/* The box's 2px inset, apart from its outline. */}
        <Line className="gap-2xs px-2xs">
          {hasOptions ? (
            <>
              <OptionsChip
                frame={frame}
                meta={meta}
                name={name}
                named={named}
                narrow={narrow}
              />
              <Separator orientation="vertical" className="h-3.5" />
            </>
          ) : null}
          <FrameVersion
            frame={frame}
            name={meta.name}
            picks={picks}
            narrow={narrow}
          />
        </Line>
      </Line>
    </ActionFormShield>
  );
}

/**
 * How many of a prototype frame's options its name spells (`frameName`: the
 * first two, plus every other one the frames differ on) — the chip's `+N`
 * counts the rest.
 */
function useNamedCount(frame: PrototypeFrame, meta: PrototypeMeta): number {
  const { canvas } = usePrototypeDetail();
  const picksOf = useStoredPicksOf();
  const named: NamedFrame[] = prototypeFrames(canvas.frames).map((f) => ({
    id: f.id,
    options: documentOptions(meta, f.version),
    picks: picksOf(f),
  }));
  const target = named.find((n) => n.id === frame.id);
  return target === undefined ? 0 : frameName(target, named).length;
}

/**
 * A source frame's tag (`.realtag`): the app glyph and its name ("Real app"),
 * dashed; what it resolved to ("/agents · App screen") is its tooltip.
 */
function SourceTag({
  label,
  detail,
}: {
  label: string;
  detail: string | null;
}): ReactElement {
  return (
    <Line
      title={detail ?? undefined}
      className="h-7 gap-xs rounded-lg border border-dashed border-border px-sm text-muted-foreground"
    >
      <Icon icon={appIcon} className="size-3.25" />
      <Text variant="group">{label}</Text>
    </Line>
  );
}

/** A prototype frame's own version stepper. */
function FrameVersion({
  frame,
  name,
  picks,
  narrow,
}: {
  frame: PrototypeFrame;
  name: string;
  picks: ReturnType<typeof useFramePicks>;
  narrow: boolean;
}): ReactElement {
  const { dispatch } = usePrototypeDetail();
  return (
    <VersionStepper
      name={name}
      shown={frame.version}
      picks={picks}
      narrow={narrow}
      show={(version) =>
        dispatch({ type: "setVersion", id: frame.id, version })
      }
      compare={(version) =>
        dispatch({ type: "addPrototype", from: frame.id, version })
      }
    />
  );
}
