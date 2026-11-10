import type { ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Placed,
  pct,
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import {
  Tooltip,
  TooltipCardContent,
  TooltipTrigger,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { axisFrac, axisTicks, pageShares } from "../internal/axis";
import { presentEvent, propsText } from "../internal/events";
import { clock, span } from "../internal/format";
import {
  readShare,
  sumS,
  type Journey,
  type JourneyPage,
  type PageGap,
} from "../internal/journey";
import { useLaneWindow } from "../internal/lane-context";
import { GAP_FILL, GAP_LABEL } from "./gap-look";

/** The space between two pages of a bar, in px. */
const PAGE_GAP = 2;

/**
 * A visit's journey on the window's shared log axis: one segment per page,
 * split by its share of the visit; under each, the read line (how much of the
 * page's known sections were reached) and a tick per section reached; over
 * it, one icon per action. Every piece names itself on hover.
 */
export function JourneyBar({ journey }: { journey: Journey }): ReactNode {
  const { axisMaxS, sections } = useLaneWindow();
  // A truncated visit's unknown tail takes its share of the bar, undrawn.
  const durations = journey.pages.map((p) => p.durationS);
  const shown = durations.reduce((a, d) => a + d, 0);
  const shares = pageShares(
    journey.truncated
      ? [...durations, Math.max(0, journey.durationS - shown)]
      : durations,
  ).slice(0, journey.pages.length);
  const starts = shares.map((_, i) =>
    shares.slice(0, i).reduce((a, x) => a + x, 0),
  );
  return (
    <div className="relative h-[46px]">
      {/* The axis' gridlines, behind every bar, so rows line up by eye. */}
      {axisTicks(axisMaxS)
        .slice(1)
        .map((t) => (
          <Placed
            key={t.s}
            decorative
            x={{ start: pct(axisFrac(t.s, axisMaxS)), size: 1 }}
            y={{ start: -6, end: -6 }}
            className="bg-border/50"
          />
        ))}
      <Placed
        x={{ start: 0, size: pct(axisFrac(journey.durationS, axisMaxS)) }}
        y="fill"
      >
        {journey.pages.map((page, i) => {
          return (
            <PageSegment
              key={i}
              page={page}
              start={starts[i]!}
              share={shares[i]!}
              first={i === 0}
              read={readShare(page, sections.get(page.path))}
              knownSections={sections.get(page.path) ?? []}
            />
          );
        })}
        {/* Each stretch away names itself on hover: a hit area over its
            shading (drawn inside the segment, under the page's label). */}
        {journey.pages.flatMap((page, i) =>
          (page.gaps ?? []).map((g, j) => (
            <GapMark
              key={`${i}:${j}`}
              gap={g}
              path={page.path}
              left={starts[i]! + shares[i]! * pageFrac(page, g.startS)}
              width={
                shares[i]! * (pageFrac(page, g.endS) - pageFrac(page, g.startS))
              }
            />
          )),
        )}
        {/* The actions sit OVER the segments as their siblings (never inside
            a segment's trigger), so hovering one names the action alone. */}
        {journey.pages.flatMap((page, i) =>
          page.actions.map((a, j) => (
            <ActionMark
              key={`${i}:${j}`}
              action={a}
              path={page.path}
              left={starts[i]! + shares[i]! * pageFrac(page, a.atS)}
            />
          )),
        )}
      </Placed>
    </div>
  );
}

/** Where `s` seconds into `page` fall along it, 0..1. */
function pageFrac(page: JourneyPage, s: number): number {
  return page.durationS > 0 ? Math.min(1, s / page.durationS) : 0;
}

export function pageTitle(path: string): string {
  if (path === "/") return "Home";
  const last = path.split("/").filter(Boolean).at(-1) ?? path;
  return last.charAt(0).toUpperCase() + last.slice(1).replaceAll("-", " ");
}

function PageSegment({
  page,
  start,
  share,
  first,
  read,
  knownSections,
}: {
  page: JourneyPage;
  start: number;
  share: number;
  first: boolean;
  read: number | null;
  knownSections: readonly string[];
}): ReactNode {
  const reached = new Set(page.reached.map((r) => r.section));
  const away = page.gaps ? sumS(page.gaps) : 0;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              placedClasses(),
              clipClasses({ axis: "both", fill: false }),
              "rounded-md bg-muted shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-accent",
            )}
            style={placedStyle(
              {
                start: first
                  ? pct(start)
                  : `calc(${pct(start)} + ${PAGE_GAP / 2}px)`,
                size: `calc(${pct(share)} - ${PAGE_GAP}px)`,
                minSize: 6,
              },
              "fill",
            )}
          />
        }
      >
        {page.gaps?.map((g, j) => (
          <Placed
            key={j}
            decorative
            x={{
              start: pct(pageFrac(page, g.startS)),
              size: pct(pageFrac(page, g.endS) - pageFrac(page, g.startS)),
            }}
            y="fill"
            className={GAP_FILL[g.kind]}
          />
        ))}
        <Placed
          x={{ start: 8, end: 4 }}
          y={{ start: 5 }}
          className={clipClasses({ axis: "x", fill: false })}
        >
          <Text as="span" variant="label" className="block whitespace-nowrap">
            {pageTitle(page.path)}
          </Text>
        </Placed>
        {read !== null && (
          <Placed
            decorative
            x={{ start: 0, size: pct(read) }}
            y={{ end: 0, size: 3 }}
            className="bg-primary/70"
          />
        )}
        {page.reached
          .filter((r) => r.atS > 0)
          .map((r) => (
            <Placed
              key={r.section}
              decorative
              x={{ start: pct(pageFrac(page, r.atS)), size: 1 }}
              y={{ end: 0, size: 7 }}
              className="bg-faint-foreground/60"
            />
          ))}
      </TooltipTrigger>
      <TooltipCardContent side="top" align="start">
        <Stack gap="2xs">
          <Text variant="label" tone="strong">
            {page.path} · {span(page.durationS)}
            {away > 0 && (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {span(page.durationS - away)} active
              </span>
            )}
          </Text>
          {knownSections.length > 0 && (
            <Stack direction="row" gap="2xs">
              {knownSections.map((s) => (
                <Fill
                  key={s}
                  className={cn(
                    "h-1 rounded-full",
                    reached.has(s) ? "bg-primary" : "bg-border",
                  )}
                />
              ))}
            </Stack>
          )}
          <Text variant="caption" tone="muted">
            {read === null
              ? "No section reached"
              : `Read ${Math.round(read * 100)}%`}
            {" · "}
            {actionsLabel(page.actions.length)}
          </Text>
        </Stack>
      </TooltipCardContent>
    </Tooltip>
  );
}

export function actionsLabel(n: number): string {
  return n === 0 ? "no action" : `${n} action${n > 1 ? "s" : ""}`;
}

function GapMark({
  gap,
  path,
  left,
  width,
}: {
  gap: PageGap;
  path: string;
  left: number;
  width: number;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={placedClasses()}
            style={placedStyle({ start: pct(left), size: pct(width) }, "fill")}
          />
        }
      />
      <TooltipCardContent side="top">
        <Stack gap="2xs">
          <Text variant="label" tone="strong">
            {GAP_LABEL[gap.kind].label} · {span(gap.endS - gap.startS)}
          </Text>
          <Text variant="caption" tone="muted">
            {path} · +{clock(gap.startS)} → +{clock(gap.endS)}
          </Text>
        </Stack>
      </TooltipCardContent>
    </Tooltip>
  );
}

function ActionMark({
  action,
  path,
  left,
}: {
  action: JourneyPage["actions"][number];
  path: string;
  left: number;
}): ReactNode {
  const ev = presentEvent(action.name);
  const props = propsText(action.props);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              placedClasses({ layer: "raised" }),
              "size-[17px] rounded-sm bg-primary text-primary-foreground shadow-[0_0_0_1.5px_var(--card)]",
            )}
            style={placedStyle(
              { center: pct(left), size: 17 },
              { start: 22, size: 17 },
            )}
          />
        }
      >
        <Center axis="both" className="size-full">
          <Icon icon={ev.icon} className="size-[11px]" />
        </Center>
      </TooltipTrigger>
      <TooltipCardContent side="top">
        <Stack gap="2xs">
          <Text variant="label" tone="strong">
            {ev.label}
          </Text>
          <Text variant="caption" tone="muted">
            {path} · +{clock(action.atS)}
            {props ? ` · ${props}` : ""}
          </Text>
        </Stack>
      </TooltipCardContent>
    </Tooltip>
  );
}
