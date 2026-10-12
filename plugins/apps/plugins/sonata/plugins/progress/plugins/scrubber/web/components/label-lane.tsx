import { Fragment, useMemo } from "react";
import type { ReactNode } from "react";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { hoverRevealGroup } from "@plugins/primitives/plugins/hover-reveal/web";
import { SonataProgress } from "../slots";
import { LABEL_LANE_HEIGHT } from "../rail-geometry";
import { groupLabels, type LaneEntry } from "../lane-layout";

type LaneItem = { key: string; node: ReactNode; align?: "end" };

/**
 * The label lane under the rail: every `SonataProgress.Label` contributor's
 * items, folded into same-beat groups (`groupLabels`) — so a key that changes
 * on a section's downbeat reads inside that section's label (`Answer G♯m`)
 * without either contributor knowing the other. Each group is placed at its
 * beat and spans up to the next group, rendering its nodes inline on one
 * clipped line.
 *
 * Each group is a size container (`@container`): a group too narrow for
 * anything hides itself here, and a contributor's node can hide its own parts
 * with `@max-[…]:` variants (e.g. drop a name below some width) — no
 * measurement, no resize loop.
 *
 * A group is one hover target across its whole width: it highlights, reveals
 * its items' `hoverRevealTarget` parts, and reports its beat through
 * `onHoverBeat` so the scrubber can thicken the rail segment it sits on.
 * `align: "end"` items sit at the group's right edge.
 *
 * NOT part of the seek target: it sits outside the slider, so a click here
 * reaches the label nodes themselves (a section label seeks / loops on its
 * own). Its height is reserved even when empty so the strip never jumps.
 */
export function LabelLane({
  score,
  beatToFraction,
  endBeat,
  onHoverBeat,
}: {
  score: Score;
  beatToFraction: (beat: number) => number;
  endBeat: number;
  /** The hovered group's beat, or `null` when the pointer leaves it. */
  onHoverBeat: (beat: number | null) => void;
}) {
  const contributions = SonataProgress.Label.useContributions();
  const groups = useMemo(() => {
    const entries: LaneEntry<LaneItem>[] = contributions.flatMap((c) =>
      c.labels(score).map((l) => ({
        beat: l.beat,
        order: c.order,
        item: { key: `${c.id}:${l.key}`, node: l.node, align: l.align },
      })),
    );
    return groupLabels(entries, endBeat);
  }, [contributions, score, endBeat]);

  return (
    <div className="relative" style={{ height: LABEL_LANE_HEIGHT }}>
      {groups.map((g) => {
        const from = beatToFraction(g.beat);
        const startItems = g.items.filter((it) => it.align !== "end");
        const endItems = g.items.filter((it) => it.align === "end");
        return (
          <Placed
            key={g.beat}
            x={{ start: pct(from), size: pct(beatToFraction(g.end) - from) }}
            y="fill"
            className="@container"
            onPointerEnter={() => onHoverBeat(g.beat)}
            onPointerLeave={() => onHoverBeat(null)}
          >
            {/* One clipped single line; the whole group disappears below the
                width of a dot, rather than showing a sliver of one. */}
            <Clip
              as={Line}
              className={cn(
                hoverRevealGroup,
                "h-full gap-xs rounded-sm px-2xs text-3xs text-muted-foreground hover:bg-foreground/5 @max-[14px]:invisible",
              )}
            >
              {startItems.map((it) => (
                <Fragment key={it.key}>{it.node}</Fragment>
              ))}
              {endItems.length > 0 ? (
                <>
                  <span className={fillClasses("x")} />
                  {endItems.map((it) => (
                    <Fragment key={it.key}>{it.node}</Fragment>
                  ))}
                </>
              ) : null}
            </Clip>
          </Placed>
        );
      })}
    </div>
  );
}
