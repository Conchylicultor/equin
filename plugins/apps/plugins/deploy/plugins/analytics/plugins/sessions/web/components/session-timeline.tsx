import type { ReactNode } from "react";
import type { Session } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { presentEvent, propsText } from "../internal/events";
import { sourceOf } from "../internal/facts";
import { clock, countryName, span, timeOfDay } from "../internal/format";
import { readShare, type JourneyPage } from "../internal/journey";
import { useLaneWindow } from "../internal/lane-context";
import { pageTitle } from "./journey-bar";

/** The timeline's three tracks: the step's time · its rail · its card. */
const STEP = "grid grid-cols-[52px_18px_minmax(0,1fr)] gap-x-sm";

/** A line in the cards' column, past the time and rail tracks (the facts, a note). */
function PastRail({ children }: { children: ReactNode }): ReactNode {
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- the timeline's fixed time / rail / card tracks (STEP); no layout primitive spells fixed px tracks
    <div className={STEP}>
      <span />
      <span />
      {children}
    </div>
  );
}

/**
 * A visit opened: its facts, then each page as a card on a rail — when it
 * opened, how long it was read, the sections reached (with when), the actions
 * in order — and where the visitor left.
 */
export function SessionTimeline({ session }: { session: Session }): ReactNode {
  const { journeys, sections } = useLaneWindow();
  const journey = journeys.get(session.id);
  if (!journey)
    throw new Error(`[sessions] no journey derived for visit ${session.id}`);
  return (
    <Stack gap="sm" className="max-w-[920px]">
      <PastRail>
        <Cluster gap="md">
          <Text variant="code" tone="muted">
            Visitor {session.visitor}
          </Text>
          <Text variant="caption" tone="muted">
            {new Date(session.startedAt).toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
            , {timeOfDay(session.startedAt)}
          </Text>
          <Text variant="caption" tone="muted">
            {countryName(session.country)}
          </Text>
          <Text variant="caption" tone="muted">
            {session.device} · {session.os} · {session.browser}
          </Text>
          <Text variant="caption" tone="muted">
            from {sourceOf(session)}
          </Text>
        </Cluster>
      </PastRail>
      <Stack gap="none">
        {journey.pages.map((page, i) => (
          <Step key={i} at={page.startS} first={i === 0} last={false}>
            <PageCard
              page={page}
              entry={i === 0}
              exit={i === journey.pages.length - 1}
              known={sections.get(page.path)}
            />
          </Step>
        ))}
        <Step at={journey.durationS} first={false} last end>
          <Inset t="sm" b="2xs">
            <Text variant="body" tone="muted">
              Left from{" "}
              <Text variant="code" tone="strong">
                {session.exitPath}
              </Text>
              {journey.bounced ? " · bounced" : ""}
            </Text>
          </Inset>
        </Step>
      </Stack>
      {session.hitsTruncated && (
        <PastRail>
          <Text variant="caption" tone="faint">
            Only this visit's first {session.hits.length} hits are shown.
          </Text>
        </PastRail>
      )}
    </Stack>
  );
}

function Step({
  at,
  first,
  last,
  end = false,
  children,
}: {
  at: number;
  first: boolean;
  last: boolean;
  end?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- the timeline's fixed time / rail / card tracks (STEP); no layout primitive spells fixed px tracks
    <div className={STEP}>
      <Inset t="smd">
        <Text
          as="div"
          variant="caption"
          tone="faint"
          className="text-right tabular-nums"
        >
          {clock(at)}
        </Text>
      </Inset>
      <div className="relative">
        {/* The rail: from the first node down to the last one. */}
        <Placed
          decorative
          x={{ start: 8, size: 1.5 }}
          y={{ start: first ? 16 : 0, end: last ? "calc(100% - 16px)" : 0 }}
          className="bg-border"
        />
        <Placed
          decorative
          x={{ start: 3, size: 12 }}
          y={{ start: 12, size: 12 }}
          className={cn(
            "rounded-full border-2",
            end
              ? "border-faint-foreground/60 bg-faint-foreground/60"
              : "border-primary bg-background",
          )}
        />
      </div>
      {children}
    </div>
  );
}

function PageCard({
  page,
  entry,
  exit,
  known,
}: {
  page: JourneyPage;
  entry: boolean;
  exit: boolean;
  known: readonly string[] | undefined;
}): ReactNode {
  const read = readShare(page, known);
  const reachedAt = new Map(page.reached.map((r) => [r.section, r.atS]));
  return (
    <Inset y="2xs" b="sm">
      <Surface level="raised" className="shadow-none">
        <Inset x="md" t="smd" b="md">
          <Stack gap="smd">
            <Line className="gap-sm">
              <Text variant="code" tone="strong">
                {page.path}
              </Text>
              <Text variant="body" tone="muted">
                {pageTitle(page.path)}
              </Text>
              {entry && (
                <Badge variant="muted" shape="pill">
                  Entry
                </Badge>
              )}
              {exit && (
                <Badge variant="muted" shape="pill">
                  Exit
                </Badge>
              )}
              <Fill />
              <Text variant="label" className="tabular-nums">
                {span(page.durationS)}
              </Text>
            </Line>
            {known && known.length > 0 && (
              <Line className="gap-2xs">
                {known.map((section) => {
                  const atS = reachedAt.get(section);
                  return (
                    <Fill key={section}>
                      <Stack gap="xs">
                        <span
                          className={cn(
                            "block h-[5px] rounded-full",
                            atS === undefined ? "bg-border" : "bg-primary/70",
                          )}
                        />
                        <Text
                          variant="caption"
                          tone={atS === undefined ? "faint" : "muted"}
                        >
                          {section}
                          {atS !== undefined && atS > 0 && (
                            <Text as="span" variant="caption" tone="faint">
                              {" "}
                              +{clock(atS)}
                            </Text>
                          )}
                        </Text>
                      </Stack>
                    </Fill>
                  );
                })}
                <Text
                  variant="caption"
                  tone="muted"
                  className="w-16 text-right tabular-nums"
                >
                  {read === null ? "—" : `${Math.round(read * 100)}% read`}
                </Text>
              </Line>
            )}
            {page.actions.length > 0 && (
              <Inset t="sm" className="border-t border-dashed border-border">
                <Stack gap="xs">
                  {page.actions.map((a, j) => {
                    const ev = presentEvent(a.name);
                    const props = propsText(a.props);
                    return (
                      <Line key={j} className="gap-sm">
                        <Text
                          variant="caption"
                          tone="faint"
                          className="w-[46px] tabular-nums"
                        >
                          +{clock(a.atS)}
                        </Text>
                        <Center
                          axis="both"
                          className="size-5 rounded-sm bg-primary/15 text-primary-text"
                        >
                          <Icon icon={ev.icon} className="size-3" />
                        </Center>
                        <Text variant="body">{ev.label}</Text>
                        {props && (
                          <Text variant="code" tone="faint">
                            {props}
                          </Text>
                        )}
                      </Line>
                    );
                  })}
                </Stack>
              </Inset>
            )}
          </Stack>
        </Inset>
      </Surface>
    </Inset>
  );
}
