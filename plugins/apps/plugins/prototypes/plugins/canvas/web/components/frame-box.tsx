import { type ReactElement, type ReactNode } from "react";
import {
  ActionFormShield,
  useActionForm,
} from "@plugins/primitives/plugins/action-presentation/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Separator } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  PrototypeMeta,
  PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypesIcons } from "@plugins/apps/plugins/prototypes/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  prototypeFrames,
  type CanvasFrame,
  type PrototypeFrame,
} from "../internal/canvas-model";
import { frameName, type NamedFrame } from "../internal/frame-name";
import type { FrameResolution } from "../slots";
import {
  documentOptions,
  useFramePicks,
  usePrototypeDetail,
  useStoredPicksOf,
} from "../context";
import { OptionsChip } from "./options-pill";
import { VersionStepper } from "./version-stepper";

const appIcon = prototypesIcons.icon("app");

/**
 * What a frame shows, as ONE box — the same component wherever a frame is
 * named, so the canvas's frame header and a presentation's tag cannot drift
 * apart. For the prototype: its options chip | its version stepper (the
 * stepper alone when the document declares no option). For a source frame:
 * the app glyph and its name ("Real app"), what it resolved to as its tooltip.
 *
 * On the canvas (`floating` absent) the box sits on the board: the prototype's
 * on the card at 70% inside a 1px line, a source's dashed. A presentation
 * floats it over the frame (`floating`): one glass surface that also holds the
 * presentation's own controls, each part split from the next by a hairline.
 *
 * Narrow (inside a frame header's adaptive bar that ran out of room) the
 * prototype's box drops its secondary labels: no `+N`, no age, no chip chevron.
 */
export function FrameShowsBox({
  frame,
  meta,
  name,
  resolution,
  compare,
  floating,
}: {
  frame: CanvasFrame;
  meta: PrototypeMeta;
  /** The frame's name ("Mist · Home", "Real app"). */
  name: string;
  /** What a source frame resolved to — `null` for a prototype frame. */
  resolution: FrameResolution | null;
  /**
   * Open a version in a new frame beside this one (the version list's Compare
   * row action) — absent where no frame can be added.
   */
  compare?: (version: PrototypeVersion) => void;
  /** Float the box as a presentation's tag, with these controls around it. */
  floating?: { leading?: ReactNode; trailing?: ReactNode };
}): ReactElement {
  const detail = resolution?.status === "found" ? resolution.tag : null;
  const shows =
    frame.kind === "prototype" ? (
      <PrototypeShows frame={frame} meta={meta} name={name} compare={compare} />
    ) : (
      <Line
        title={detail ?? undefined}
        className="gap-xs text-muted-foreground"
      >
        <Icon icon={appIcon} className="size-3.25" />
        <Text variant="group">{name}</Text>
      </Line>
    );

  if (floating === undefined) {
    return frame.kind === "prototype" ? (
      <Line className="h-7 rounded-lg border border-border/64 bg-card/70 [--hover-fill:var(--accent)]">
        {/* The box's 2px inset, apart from its outline. */}
        <Line className="gap-2xs px-2xs">{shows}</Line>
      </Line>
    ) : (
      <Line className="h-7 rounded-lg border border-dashed border-border px-sm">
        {shows}
      </Line>
    );
  }

  const { leading, trailing } = floating;
  return (
    <Surface level="float">
      <Line className="h-8 gap-2xs px-2xs [--hover-fill:var(--accent)]">
        {leading}
        {leading ? <Divider /> : null}
        {frame.kind === "prototype" ? (
          shows
        ) : (
          <Line className="px-xs">{shows}</Line>
        )}
        {trailing ? <Divider /> : null}
        {trailing}
      </Line>
    </Surface>
  );
}

/** The hairline between two parts of the box (the chip | the stepper). */
function Divider(): ReactElement {
  return <Separator orientation="vertical" className="h-3.5" />;
}

/**
 * A prototype frame's part of the box (`.fbox`): its options chip | its
 * version stepper. It gives up room late, after a header's actions, since it
 * is what a frame's header is for — and then only its secondary labels (the
 * narrow form).
 */
function PrototypeShows({
  frame,
  meta,
  name,
  compare,
}: {
  frame: PrototypeFrame;
  meta: PrototypeMeta;
  name: string;
  compare: ((version: PrototypeVersion) => void) | undefined;
}): ReactElement {
  const { dispatch } = usePrototypeDetail();
  const narrow =
    useActionForm({ shrinksTo: ["compact"], yields: "late" }) === "compact";
  const named = useNamedCount(frame, meta);
  const picks = useFramePicks(frame, meta);
  const hasOptions = documentOptions(meta, frame.version).length > 0;
  // The box's ladder is its item's: the chip and the stepper are parts of it,
  // not occupants that each declare a form of their own.
  return (
    <ActionFormShield>
      <Line className="gap-2xs">
        {hasOptions ? (
          <>
            <OptionsChip
              frame={frame}
              meta={meta}
              name={name}
              named={named}
              narrow={narrow}
            />
            <Divider />
          </>
        ) : null}
        <VersionStepper
          name={meta.name}
          shown={frame.version}
          picks={picks}
          narrow={narrow}
          show={(version) =>
            dispatch({ type: "setVersion", id: frame.id, version })
          }
          compare={compare}
        />
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
