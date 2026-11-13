import type { KeyboardEvent, ReactNode } from "react";
import type { Session } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import type { LoadTiming } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
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
import {
  pageRead,
  readLabel,
  sumS,
  type PageRead,
  type JourneyPage,
  type PageAction,
  type PageGap,
} from "../internal/journey";
import { useLaneWindow } from "../internal/lane-context";
import {
  loadPhases,
  seconds,
  visitLoad,
  type LoadPhase,
} from "../internal/load";
import { GAP_LABEL, GapSwatch } from "./gap-look";
import { pageTitle } from "./journey-bar";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { replayPane } from "./replay-pane";

const replayIcon = symbol("play-circle");

/**
 * Opens this visit's replay from page `page` (0 = the visit's start), or
 * `null` for a visit with no site to play it on (the exhibit's made-up ones).
 */
function useOpenReplay(visitId: string): ((page: number) => void) | null {
  const { deploymentId } = useLaneWindow();
  const openPane = useOpenPane();
  if (deploymentId === null) return null;
  return (page) =>
    openPane(
      replayPane,
      {
        deploymentId,
        visitId,
        ...(page > 0 ? { page: String(page) } : {}),
      },
      { mode: "root" },
    );
}

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
 * A visit opened: its facts and how its page load went, then each page as a
 * card on a rail — when it opened, how long it was read (and how much of it
 * active), the sections reached (with when), the actions and the stretches
 * away in order — and where the visitor left.
 */
export function SessionTimeline({ session }: { session: Session }): ReactNode {
  const { journeys, sections } = useLaneWindow();
  const journey = journeys.get(session.id);
  if (!journey)
    throw new Error(`[sessions] no journey derived for visit ${session.id}`);
  const load = visitLoad(session);
  const openReplay = useOpenReplay(session.id);
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
          {openReplay !== null && (
            <Button
              variant="outline"
              onClick={() => openReplay(0)}
              tooltip="Play the visit on the local serve, at the visitor's screen size"
            >
              <Icon icon={replayIcon} className="size-4" />
              Replay
            </Button>
          )}
        </Cluster>
      </PastRail>
      {load !== null && loadPhases(load).length > 0 && (
        <PastRail>
          <LoadLine load={load} />
        </PastRail>
      )}
      <Stack gap="none">
        {journey.pages.map((page, i) => (
          <Step key={i} at={page.startS} first={i === 0} last={false}>
            <PageCard
              page={page}
              entry={i === 0}
              exit={i === journey.pages.length - 1}
              read={pageRead(page, sections)}
              onReplay={openReplay === null ? null : () => openReplay(i)}
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

const PHASE_FILL: Record<LoadPhase["key"], string> = {
  server: "bg-primary/40",
  paint: "bg-primary/65",
  ready: "bg-primary",
};

/** The page load: when it was ready, then server → first paint → ready as one bar, each phase keyed. */
function LoadLine({ load }: { load: LoadTiming }): ReactNode {
  const phases = loadPhases(load);
  const totalMs = phases.at(-1)!.endMs;
  return (
    <Cluster gap="smd">
      <Text variant="caption" tone="muted">
        {load.readyMs !== null ? (
          <>
            Loaded in{" "}
            <b className="font-semibold text-foreground tabular-nums">
              {seconds(load.readyMs, 2)}
            </b>
          </>
        ) : (
          "Loaded in a background tab"
        )}
      </Text>
      <Fill className="relative h-2 min-w-[240px] max-w-[420px] rounded-sm bg-accent">
        {phases.map((p) => (
          <Placed
            key={p.key}
            decorative
            x={{
              start: pct(p.startMs / totalMs),
              size: pct(p.spanMs / totalMs),
            }}
            y="fill"
            className={PHASE_FILL[p.key]}
          />
        ))}
      </Fill>
      {phases.map((p) => (
        <Line key={p.key} className="gap-xs">
          <span
            aria-hidden
            className={cn("inline-block size-2 rounded-xs", PHASE_FILL[p.key])}
          />
          <Text variant="caption" tone="muted" className="tabular-nums">
            {p.key === "server"
              ? `server ${p.endMs} ms`
              : p.key === "paint"
                ? `first paint ${seconds(p.endMs, 2)}`
                : "ready"}
          </Text>
        </Line>
      ))}
    </Cluster>
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
  read,
  onReplay,
}: {
  page: JourneyPage;
  entry: boolean;
  exit: boolean;
  read: PageRead;
  /** Replays the visit from this page; `null` when there is no site to play it on. */
  onReplay: (() => void) | null;
}): ReactNode {
  const known = read.sections;
  const reachedAt = new Map(page.reached.map((r) => [r.section, r.atS]));
  const away = page.gaps ? sumS(page.gaps) : 0;
  // What happened on the page, in time order: its actions and its stretches away.
  const items: (
    { at: number; action: PageAction } | { at: number; gap: PageGap }
  )[] = [
    ...page.actions.map((action) => ({ at: action.atS, action })),
    ...(page.gaps ?? []).map((gap) => ({ at: gap.startS, gap })),
  ].sort((a, b) => a.at - b.at);
  return (
    <Inset y="2xs" b="sm">
      <Surface
        level="raised"
        className={cn(
          "shadow-none",
          onReplay !== null &&
            "cursor-pointer transition-shadow hover:shadow-[0_0_0_1px_var(--primary)]",
        )}
        {...(onReplay !== null
          ? {
              role: "button",
              tabIndex: 0,
              title: "Replay the visit from this page",
              onClick: onReplay,
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onReplay();
                }
              },
            }
          : {})}
      >
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
                {away > 0 && (
                  <span className="font-normal text-faint-foreground">
                    {" "}
                    · {span(page.durationS - away)} active
                  </span>
                )}
              </Text>
            </Line>
            {known.length > 0 && (
              <Stack gap="2xs">
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
                    className="w-20 text-right tabular-nums"
                >
                    {readLabel(read) ?? "—"}
                </Text>
              </Line>
                {read.estimated && (
                  <Text variant="caption" tone="faint">
                    Estimated: this visit did not record the page&apos;s
                    sections, so they are the ones other loaded visits reached
                  </Text>
                )}
              </Stack>
            )}
            {items.length > 0 && (
              <Inset t="sm" className="border-t border-dashed border-border">
                <Stack gap="xs">
                  {items.map((it, j) =>
                    "action" in it ? (
                      <ActionLine key={j} action={it.action} />
                    ) : (
                      <GapLine key={j} gap={it.gap} />
                    ),
                  )}
                </Stack>
              </Inset>
            )}
          </Stack>
        </Inset>
      </Surface>
    </Inset>
  );
}

function ActionLine({ action }: { action: PageAction }): ReactNode {
  const ev = presentEvent(action.name);
  const props = propsText(action.props);
  return (
    <Line className="gap-sm">
      <Text variant="caption" tone="faint" className="w-[46px] tabular-nums">
        +{clock(action.atS)}
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
}

function GapLine({ gap }: { gap: PageGap }): ReactNode {
  return (
    <Line className="gap-sm">
      <Text variant="caption" tone="faint" className="w-[46px] tabular-nums">
        +{clock(gap.startS)}
      </Text>
      <GapSwatch kind={gap.kind} className="size-5 rounded-sm" />
      <Text variant="body" tone="muted" className="italic">
        {GAP_LABEL[gap.kind].label} · {span(gap.endS - gap.startS)}
      </Text>
    </Line>
  );
}
