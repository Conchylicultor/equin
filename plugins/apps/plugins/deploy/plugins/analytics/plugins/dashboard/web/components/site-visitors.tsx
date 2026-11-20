import type { ReactNode } from "react";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  SiteLiveAside,
  SiteLiveBlock,
  siteFreshness,
  type SiteExhibitState,
  type SiteFreshness,
  type SiteLiveExhibitProps,
  type SiteLiveProps,
} from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";
import type { SiteHealth } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";
import type { VisitorPulse } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { SiteVisitors } from "../slots";
import { useAnalyticsPulse } from "../internal/use-analytics-pulse";
import { useShipsAnalytics } from "../internal/use-analytics-available";

/** "now · synced live" / "synced 4m ago" — how fresh the numbers are. */
function freshnessWords(freshness: SiteFreshness, asOf: string): string {
  switch (freshness.kind) {
    case "live":
      return "now · synced live";
    case "stale":
      return `synced ${formatRelativeTime(new Date(freshness.lastHeardAt ?? asOf))}`;
    case "elsewhere":
      return `synced ${formatRelativeTime(new Date(asOf))}`;
  }
}

/**
 * The last hour of visitors, one bar a minute, the newest solid — grey once
 * the link is not live (the hour is what it was when last heard).
 */
function Sparkline({
  minutes,
  stale,
}: {
  minutes: readonly number[];
  stale: boolean;
}) {
  const max = Math.max(1, ...minutes);
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- a bar chart: sixty equal bars standing on one baseline, a hairline apart (below the spacing ramp)
    <div className="flex h-[22px] items-end gap-px" aria-hidden>
      {minutes.map((n, i) => (
        <i
          key={i}
          // eslint-disable-next-line layout/no-adhoc-layout -- each bar takes an equal share of the chart's width
          className={cn(
            "min-h-px flex-1 rounded-t-[1px]",
            stale
              ? "bg-foreground/10"
              : i === minutes.length - 1
                ? "bg-success"
                : "bg-success/45",
          )}
          style={{ height: `${(n / max) * 100}%` }}
        />
      ))}
    </div>
  );
}

/** The Visitors block, drawn from a pulse: today (and its notes), the hour, its freshness. */
export function VisitorsView({
  pulse,
  freshness,
  notes,
}: {
  pulse: VisitorPulse;
  freshness: SiteFreshness;
  /** The notes after the count — the live slot, or an exhibit's. */
  notes: (stale: boolean) => ReactNode;
}) {
  const stale = freshness.kind === "stale";
  return (
    <SiteLiveBlock
      title="Visitors"
      aside={
        <>
          <SiteLiveAside>
            <span className="font-semibold text-strong-foreground">
              {pulse.visitorsToday}
            </span>
            {" today"}
          </SiteLiveAside>
          {notes(stale)}
        </>
      }
    >
      <Stack gap="2xs">
        <Sparkline minutes={pulse.sparkline} stale={stale} />
        <Line className="gap-sm">
          <Text variant="caption" tone="faint">
            1 h ago
          </Text>
          <Fill />
          <Text variant="caption" tone="faint">
            {freshnessWords(freshness, pulse.asOf)}
          </Text>
        </Line>
      </Stack>
    </SiteLiveBlock>
  );
}

/** The live notes: every `SiteVisitors.Note` contribution, each after a " · ". */
function liveNotes(deploymentId: string) {
  return (stale: boolean) => (
    <SiteVisitors.Note.Render>
      {(note) => <note.component deploymentId={deploymentId} stale={stale} />}
    </SiteVisitors.Note.Render>
  );
}

/**
 * The Visitors block of a site's row: the pulse computed from this
 * computer's copy of the site's analytics, for a deployment that records
 * visits. Not copied yet is loading — never zero visitors.
 */
export function VisitorsSection({
  deploymentId,
  site,
}: SiteLiveProps): ReactNode {
  const ships = useShipsAnalytics(deploymentId);
  const pulse = useAnalyticsPulse(deploymentId);
  switch (ships.kind) {
    case "no":
      return null;
    case "pending":
      return (
        <SiteLiveBlock title="Visitors">
          <Loading variant="rows" count={2} />
        </SiteLiveBlock>
      );
    case "failed":
      return (
        <SiteLiveBlock title="Visitors">
          <ResourceErrorInline
            variant="inline"
            subject="what this site ships"
            error={ships.error}
            refetch={ships.refetch}
          />
        </SiteLiveBlock>
      );
    case "yes":
      break;
  }
  switch (pulse.status) {
    case "loading":
      return (
        <SiteLiveBlock title="Visitors">
          <Loading variant="rows" count={2} />
        </SiteLiveBlock>
      );
    case "error":
      return (
        <SiteLiveBlock title="Visitors">
          <ResourceErrorInline
            variant="inline"
            subject="the site's visitors"
            error={pulse.error}
            refetch={pulse.refetch}
          />
        </SiteLiveBlock>
      );
    case "ready":
      return pulse.data.kind === "not-copied" ? (
        <SiteLiveBlock
          title="Visitors"
          aside={<SiteLiveAside>Copying…</SiteLiveAside>}
        >
          <Loading variant="rows" count={2} />
        </SiteLiveBlock>
      ) : (
        <VisitorsView
          pulse={pulse.data}
          freshness={siteFreshness(site)}
          notes={liveNotes(deploymentId)}
        />
      );
  }
}

/**
 * Whether "now" means anything: a site whose box is not answering (down,
 * unreachable, refused) has no visitors to count right now — "—", not its
 * last count.
 */
function answering(site: SiteHealth): boolean {
  if (site.link.kind === "main-only") return true;
  switch (site.link.link.state.kind) {
    case "down":
    case "unreachable":
    case "refused":
      return false;
    case "connecting":
    case "live":
    case "reconnecting":
    case "outdated":
      return true;
  }
}

/** "7 visitors now" — the title line's figure, dimmed once the link is stale. */
export function VisitorsNowView({
  now,
  site,
}: {
  now: number;
  site: SiteHealth;
}) {
  const stale = siteFreshness(site).kind === "stale";
  const shown = answering(site) ? String(now) : "—";
  return (
    <Stack gap="none" align="end" className={cn(stale && "opacity-50")}>
      <Text variant="subheading" className="font-semibold tabular-nums">
        {shown}
      </Text>
      <Text variant="caption" tone="faint">
        {now === 1 ? "visitor now" : "visitors now"}
      </Text>
    </Stack>
  );
}

/** The live figure: nothing until the pulse is known (the body says why). */
export function VisitorsNow({ deploymentId, site }: SiteLiveProps): ReactNode {
  const ships = useShipsAnalytics(deploymentId);
  const pulse = useAnalyticsPulse(deploymentId);
  if (ships.kind !== "yes") return null;
  switch (pulse.status) {
    case "ready":
      return pulse.data.kind === "pulse" ? (
        <VisitorsNowView now={pulse.data.visitorsNow} site={site} />
      ) : null;
    // A figure is a number or nothing: its block in the body draws the
    // loading and failed states.
    case "loading":
    case "error":
      return null;
  }
}

// ─── Exhibits ──────────────────────────────────────────────────────────────

/** The prototype's hour of visitors, as a fixture. */
const HOUR = [
  3, 4, 2, 5, 6, 4, 3, 5, 7, 8, 6, 5, 4, 6, 9, 11, 8, 7, 6, 5, 4, 6, 7, 9, 12,
  10, 8, 7, 6, 8, 9, 7, 6, 5, 7, 8, 10, 9, 7, 6, 5, 6, 8, 7, 6, 7, 9, 8, 7, 6,
  7, 8, 6, 7, 9, 8, 7, 8, 7, 7,
];

function exhibitPulse(state: SiteExhibitState): VisitorPulse {
  const sparkline =
    state === "down"
      ? [...HOUR.slice(0, 43), ...Array<number>(17).fill(0)]
      : state === "reconnecting"
        ? [...HOUR.slice(0, 56), ...Array<number>(4).fill(0)]
        : HOUR;
  return {
    visitorsNow: 7,
    visitorsToday: 312,
    sparkline,
    asOf: new Date().toISOString(),
  };
}

/** The Visitors block in an exhibit state, its notes their owners' exhibits. */
export function VisitorsSectionExhibit({
  deploymentId,
  site,
  state,
}: SiteLiveExhibitProps): ReactNode {
  return (
    <VisitorsView
      pulse={exhibitPulse(state)}
      freshness={siteFreshness(site)}
      notes={(stale) => (
        <SiteVisitors.Note.Render>
          {(note) =>
            note.exhibit ? (
              <note.exhibit
                deploymentId={deploymentId}
                stale={stale}
                state={state}
              />
            ) : null
          }
        </SiteVisitors.Note.Render>
      )}
    />
  );
}

/** The title line's figure in an exhibit state. */
export function VisitorsNowExhibit({ site }: SiteLiveExhibitProps): ReactNode {
  return <VisitorsNowView now={7} site={site} />;
}
