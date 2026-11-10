import { useMemo, useState, type ReactNode } from "react";
import {
  SESSION_SHAPES,
  type AnalyticsRange,
  type Session,
  type SessionShape,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import {
  HostQueryErrorState,
  HostQueryFailureState,
  useDeploymentShips,
  useShipsGate,
  type HostQuerySubject,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { COLLECT_PLUGIN_ID } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  ResourceErrorInline,
  type ResourceReadiness,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  useLivePagedValuePaging,
  type FieldDef,
  type LivePagesPaging,
} from "@plugins/primitives/plugins/data-view/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  deploymentSessions,
  type DeploymentSessionsMeta,
  type DeploymentSessionsQuestion,
} from "../../core";
import { axisMaxS } from "../internal/axis";
import { sourceOf } from "../internal/facts";
import { countryName, median, span } from "../internal/format";
import { journeyOf, sectionsByPath, type Journey } from "../internal/journey";
import { LaneWindowContext, type LaneWindow } from "../internal/lane-context";
import { SessionLane } from "./session-lane";
import { SessionTimeline } from "./session-timeline";
import { sessionsToolbar } from "./sessions-toolbar";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const SESSIONS_VIEW = defineDataView("deploy-sessions");

const refreshIcon = symbol("refresh");

const SUBJECT: HostQuerySubject = {
  reading: "visits",
  answer: "a list of visits",
};

/** The ranges a visit list can ask: every day of them still has raw rows. */
const RANGES: readonly { id: Exclude<AnalyticsRange, "12m">; label: string }[] =
  [
    { id: "today", label: "Today" },
    { id: "7d", label: "7d" },
    { id: "30d", label: "30d" },
  ];

const SHAPE_LABEL: Record<SessionShape, string> = {
  all: "All",
  actions: "With actions",
  multi: "2+ pages",
  bounced: "Bounced",
};

/** The tab's gate: the same "ships collect" rule as the Analytics tab's. */
export function useSessionsAvailable({
  deploymentId,
}: {
  deploymentId: string;
}): boolean {
  return useShipsGate(deploymentId, COLLECT_PLUGIN_ID);
}

/**
 * **Sessions** — one row per anonymous visit of the deployed site, read from
 * the box over SSH when the tab opens (and on Refresh), paged as the list
 * scrolls. Shown only when the deployment's composition ships collect.
 */
export function SessionsSection({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const ships = useDeploymentShips(deploymentId, COLLECT_PLUGIN_ID);
  switch (ships.kind) {
    case "pending":
      return <Loading variant="rows" count={3} />;
    case "failed":
      return (
        <ResourceErrorInline
          variant="block"
          subject="whether this deployment records visits"
          error={ships.error}
          refetch={ships.refetch}
        />
      );
    case "yes":
      return <SessionsTab deploymentId={deploymentId} />;
    // The gate removes the tab on `no`.
    case "no":
      return null;
  }
}

function SessionsTab({ deploymentId }: { deploymentId: string }): ReactNode {
  const [range, setRange] = useState<Exclude<AnalyticsRange, "12m">>("7d");
  const [shape, setShape] = useState<SessionShape>("all");
  const question: DeploymentSessionsQuestion = { deploymentId, range, shape };
  // Each read is an SSH session to the box, so nothing re-asks on its own:
  // the pages are measured as the list needs them, Refresh re-measures both.
  const meta = useLive(deploymentSessions.meta, question);
  const { pages, paging } = useLivePagedValuePaging(
    deploymentSessions,
    question,
  );
  const counts =
    meta.status === "ready" && meta.data.kind === "sessions"
      ? meta.data.counts
      : null;

  return (
    <Stack gap="none">
      <Inset t="lg" b="smd">
        <Line className="gap-smd">
          <SegmentedControl
            options={RANGES}
            value={range}
            onChange={setRange}
          />
          <Fill />
          {meta.status === "ready" && meta.data.kind === "sessions" && (
            <Text variant="caption" tone="faint">
              Read from the box{" "}
              <RelativeTime date={new Date(meta.data.generatedAt)} />
            </Text>
          )}
          <IconButton
            icon={refreshIcon}
            label="Refresh"
            loading={meta.status === "loading"}
            onClick={() => {
              void meta.refresh();
              void pages.refresh();
            }}
          />
        </Line>
      </Inset>
      {meta.status === "error" ? (
        <ResourceErrorInline
          variant="block"
          subject="this deployment's visits"
          error={meta.error}
          refetch={meta.refresh}
        />
      ) : meta.status === "ready" && meta.data.kind !== "sessions" ? (
        <MetaFailure meta={meta.data} />
      ) : (
        <SessionsList
          rows={pages.status === "ready" ? pages.rows : NO_SESSIONS}
          readiness={pages.status === "ready" ? READY : pages}
          paging={paging}
          shape={shape}
          onShape={setShape}
          counts={counts}
        />
      )}
    </Stack>
  );
}

const NO_SESSIONS: readonly Session[] = [];
const READY: ResourceReadiness = { status: "ready" };

function MetaFailure({
  meta,
}: {
  meta: Exclude<DeploymentSessionsMeta, { kind: "sessions" }>;
}): ReactNode {
  if (meta.kind === "refused")
    return (
      <HostQueryErrorState
        title={`Visits are kept for ${meta.rawWindowDays} days — pick a shorter range.`}
      />
    );
  return <HostQueryFailureState failure={meta} subject={SUBJECT} />;
}

const FIELDS: FieldDef<Session>[] = [
  {
    id: "country",
    label: "Country",
    type: "text",
    primary: true,
    value: (s) => countryName(s.country),
    filterable: true,
  },
  {
    id: "startedAt",
    label: "Started",
    type: "date",
    value: (s) => new Date(s.startedAt),
    sortable: true,
    groupable: true,
  },
  {
    id: "channel",
    label: "Channel",
    type: "text",
    value: (s) => s.channel,
    filterable: true,
    groupable: true,
  },
  {
    id: "device",
    label: "Device",
    type: "text",
    value: (s) => s.device,
    filterable: true,
    groupable: true,
  },
  {
    id: "returning",
    label: "Returning",
    type: "bool",
    value: (s) => s.returning,
    filterable: true,
  },
];

function searchText(s: Session): string {
  return [
    countryName(s.country),
    sourceOf(s),
    s.channel,
    s.device,
    s.os,
    s.browser,
    ...new Set(s.hits.map((h) => h.path)),
  ].join(" ");
}

export function SessionsList({
  rows,
  readiness,
  paging,
  shape,
  onShape,
  counts,
}: {
  rows: readonly Session[];
  readiness: ResourceReadiness;
  paging: LivePagesPaging | null;
  shape: SessionShape;
  onShape: (s: SessionShape) => void;
  counts: Record<SessionShape, number> | null;
}): ReactNode {
  // Everything the rows share, derived once per loaded window.
  const laneWindow = useMemo<LaneWindow>(() => {
    const journeys = new Map<string, Journey>(
      rows.map((s) => [s.id, journeyOf(s)]),
    );
    const all = [...journeys.values()];
    return {
      journeys,
      sections: sectionsByPath(all),
      axisMaxS: axisMaxS(Math.max(0, ...all.map((j) => j.durationS))),
    };
  }, [rows]);
  const loaded = [...laneWindow.journeys.values()];
  const med = median(loaded.map((j) => j.durationS));
  const withActions = loaded.filter((j) => j.actionCount > 0).length;

  return (
    <LaneWindowContext.Provider value={laneWindow}>
      <DataView<Session>
        rows={rows}
        fields={FIELDS}
        rowKey={(s) => s.id}
        storageKey={SESSIONS_VIEW}
        views={["list"]}
        pinnedView="sessions"
        readiness={readiness}
        paging={paging ?? undefined}
        toolbar={sessionsToolbar}
        searchAccessor={searchText}
        searchPlaceholder="Filter by page, source, country…"
        actions={
          <>
            <SegmentedControl
              label="Which visits"
              options={SESSION_SHAPES.map((id) => ({
                id,
                label: (
                  <>
                    {SHAPE_LABEL[id]}
                    {counts && (
                      // Inline in the segment's own line: a <Text> here is a
                      // block-level leaf and would break the label in two.
                      <span className="text-faint-foreground tabular-nums">
                        {" "}
                        {counts[id]}
                      </span>
                    )}
                  </>
                ),
              }))}
              value={shape}
              onChange={onShape}
            />
            <Fill />
            <Line className="gap-md">
              {counts && (
                <Text variant="caption" tone="muted">
                  <Strong>{counts[shape]}</Strong> sessions
                </Text>
              )}
              {med !== null && (
                <Text variant="caption" tone="muted">
                  median <Strong>{span(med)}</Strong>
                </Text>
              )}
              <Text variant="caption" tone="muted">
                <Strong>{withActions}</Strong> with actions
              </Text>
            </Line>
          </>
        }
        viewOptions={{
          list: {
            renderRow: (s: Session) => <SessionLane session={s} />,
            detail: (s: Session) => <SessionTimeline session={s} />,
            detailOnActivate: true,
            frame: "card",
          },
        }}
        emptyState={<>No visit in this range.</>}
      />
    </LaneWindowContext.Provider>
  );
}

/** A figure inside a summary phrase: inline, so the phrase stays one line. */
function Strong({ children }: { children: ReactNode }): ReactNode {
  return (
    <b className="font-semibold text-foreground tabular-nums">{children}</b>
  );
}
