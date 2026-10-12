import { Fragment, useSyncExternalStore } from "react";
import type { ReactNode, RefObject } from "react";
import type {
  Score,
  TempoIndex,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { FloatingSurface } from "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SonataProgress } from "../slots";
import { formatTime } from "./format-time";

/** Where the pointer is over the track: the (possibly snapped) beat and its
 *  [0,1] position. `null` = not hovering. */
export type HoverPoint = { beat: number; fraction: number };

/**
 * A one-value store the scrubber's pointer handlers write and only the preview
 * reads — so a pointer move re-renders the small preview box, never the bar
 * (its rail, markers and labels stay put).
 */
export type HoverStore = {
  get: () => HoverPoint | null;
  set: (p: HoverPoint | null) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createHoverStore(): HoverStore {
  let value: HoverPoint | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (p) => {
      value = p;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

/** A described value worth printing — contributors return null/false for
 *  "nothing to say here". */
function present(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

/**
 * The hover preview above the slider: the time at the hovered beat, then every
 * `head` description on the first line and every `body` description on the
 * second, joined with " · " — each line in contribution `order`. The scrubber
 * knows none of the contributors (bar number, section, key): it only lays out
 * what they describe.
 *
 * It floats in the overlay layer (`FloatingSurface`, portalled), anchored to a
 * zero-width rect at the hovered point spanning the whole slider column (rail
 * + label lane) — so no neighbouring chrome (the player's top bar) can paint
 * over it, it never covers the labels it describes, and it flips above / shifts
 * sideways to stay on screen. The anchor reads the track's rect lazily, inside
 * Floating UI's measure, never during render.
 */
export function HoverPreview({
  store,
  score,
  tempo,
  trackRef,
  columnRef,
}: {
  store: HoverStore;
  score: Score;
  tempo: TempoIndex;
  /** The track the hovered fraction is measured along. */
  trackRef: RefObject<HTMLElement | null>;
  /** The slider column (rail + label lane) the preview sits beside. */
  columnRef: RefObject<HTMLElement | null>;
}) {
  const point = useSyncExternalStore(store.subscribe, store.get);
  const describes = SonataProgress.Describe.useContributions();
  if (!point) return null;

  const lines = [...describes]
    .sort((a, b) => a.order - b.order)
    .map((d) => ({
      id: d.id,
      line: d.line,
      node: d.describe(score, point.beat),
    }))
    .filter((d) => present(d.node));
  const head = lines.filter((d) => d.line === "head");
  const body = lines.filter((d) => d.line === "body");

  return (
    <FloatingSurface
      open
      anchor={{
        getBoundingClientRect: () => {
          const track = trackRef.current;
          const column = columnRef.current;
          if (!track || !column) {
            throw new Error("hover preview: slider is not mounted");
          }
          const t = track.getBoundingClientRect();
          const c = column.getBoundingClientRect();
          return new DOMRect(
            t.left + point.fraction * t.width,
            c.top,
            0,
            c.height,
          );
        },
      }}
      side="bottom"
      align="center"
      sideOffset={6}
      scroll={false}
    >
      <Stack gap="2xs">
        <Line className="gap-sm">
          <Text variant="caption" className="font-semibold tabular-nums">
            {formatTime(tempo.beatToSeconds(point.beat))}
          </Text>
          {head.map((d) => (
            <Text key={d.id} variant="caption" tone="muted">
              {d.node}
            </Text>
          ))}
        </Line>
        {body.length > 0 ? (
          <Line>
            <Text variant="caption" tone="muted">
              {body.map((d, i) => (
                <Fragment key={d.id}>
                  {i > 0 ? " · " : null}
                  {d.node}
                </Fragment>
              ))}
            </Text>
          </Line>
        ) : null}
      </Stack>
    </FloatingSurface>
  );
}
