import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  ANALYTICS_MIRROR_SET_ID,
  COLLECT_PLUGIN_ID,
  DEVICE_FAMILIES,
  type Session,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import {
  useDeploymentShips,
  useShipsGate,
  type HostQuerySubject,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { siteMirrorStatus } from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/core";
import { MirrorFreshness } from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  ResourceErrorInline,
  type ResourceReadiness,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  DataViewSwitcher,
  defineDataView,
  defineDataViewSources,
  fieldOverrides,
  useLivePagesPaging,
  type DataViewPaging,
  type DataViewSourceProps,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  QuickFilter,
  QuickFilterOption,
} from "@plugins/primitives/plugins/data-view/core";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { deploymentSessions, sessionOf, type SessionRow } from "../../core";
import { axisMaxS } from "../internal/axis";
import { sourceOf } from "../internal/facts";
import { countryName, median } from "../internal/format";
import { journeyOf, sectionsByPath, type Journey } from "../internal/journey";
import { visitLoad } from "../internal/load";
import { LaneWindowContext, type LaneWindow } from "../internal/lane-context";
import { SessionLane } from "./session-lane";
import { SessionTimeline } from "./session-timeline";
import { sessionsToolbar } from "./sessions-toolbar";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const SESSIONS_VIEW = defineDataView("deploy-sessions");

const SUBJECT: HostQuerySubject = {
  reading: "visits",
  answer: "a page of analytics rows",
};

/**
 * Where the Sessions surface's rows come from: one source, `visits` — a
 * site's live visits, or (the exhibit) made-up ones. A source so the rows are
 * in hand: every lane shares one axis and one section estimate, derived from
 * the loaded window.
 */
export type SessionsHostProps =
  | { kind: "site"; deploymentId: string }
  | { kind: "fixture"; rows: readonly SessionRow[] };

export const SessionsSources = defineDataViewSources<SessionsHostProps>();

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
 * this computer's copy of the site's analytics tables (site-mirror), paged as
 * the list scrolls and kept live as pulls land. Shown only when the
 * deployment's composition ships collect.
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
  return (
    <Stack gap="none">
      <Inset t="lg" b="smd">
        <MirrorFreshness
          deploymentId={deploymentId}
          setId={ANALYTICS_MIRROR_SET_ID}
          subject={SUBJECT}
        />
      </Inset>
      <WhenCopied deploymentId={deploymentId} />
    </Stack>
  );
}

/**
 * The list, once this computer holds a whole copy of the site's analytics.
 * Before that it is not known yet — a loading state, never an empty list
 * (the freshness line above says what the copy is doing, or why it failed).
 */
function WhenCopied({ deploymentId }: { deploymentId: string }): ReactNode {
  const status = useLive(siteMirrorStatus, { deploymentId });
  switch (status.status) {
    case "loading":
      return <Loading variant="rows" count={6} />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="whether this site's visits are copied yet"
          error={status.error}
          refetch={status.refetch}
        />
      );
    case "ready": {
      const row = status.data.find((r) => r.setId === ANALYTICS_MIRROR_SET_ID);
      return row?.copied === true ? (
        <SessionsList host={{ kind: "site", deploymentId }} />
      ) : (
        <Loading variant="rows" count={6} />
      );
    }
  }
}

/** The Sessions DataView over `host`'s visits. */
export function SessionsList({ host }: { host: SessionsHostProps }): ReactNode {
  return (
    <DataViewSwitcher<SessionsHostProps>
      storageKey={SESSIONS_VIEW}
      sources={SessionsSources}
      hostProps={host}
      viewEdits={{ mode: "draft" }}
      toolbar={sessionsToolbar}
      searchPlaceholder="Filter by page, source, country…"
    />
  );
}

/** The `visits` source: a site's live visits, or the exhibit's made-up ones. */
export function VisitsSource(
  props: DataViewSourceProps<SessionsHostProps>,
): ReactElement {
  return props.hostProps.kind === "site" ? (
    <SiteVisits {...props} deploymentId={props.hostProps.deploymentId} />
  ) : (
    <VisitsBundle
      render={props.render}
      rows={props.hostProps.rows}
      readiness={READY}
      paging={undefined}
    />
  );
}

const READY: ResourceReadiness = { status: "ready" };
const rowKeyOf = (row: SessionRow): string => row.key;
const NO_ROWS: readonly SessionRow[] = [];

/**
 * A site's visits as live key-range pages of its copy, paged by the active
 * view's filter (`narrowBy`: the shape, whose visits, the device — run by
 * collect's SQL on the copy), with the total it matches.
 */
function SiteVisits({
  deploymentId,
  view,
  render,
}: DataViewSourceProps<SessionsHostProps> & {
  deploymentId: string;
}): ReactElement {
  // The filter language's own clause: the paged read ANDs the view's filter
  // into it (`narrowBy`), so it is spelled as the language, not shorthand.
  const query = useMemo(
    () => ({ where: clause("deploymentId", "eq", deploymentId) }),
    [deploymentId],
  );
  const { pages, paging } = useLivePagesPaging(deploymentSessions, query, {
    narrowBy: view,
    total: true,
  });
  return (
    <VisitsBundle
      render={render}
      rows={pages.status === "ready" ? pages.rows : NO_ROWS}
      readiness={pages.status === "ready" ? READY : pages}
      paging={paging === null ? undefined : paging}
    />
  );
}

// Every field but the site, which every read is scoped by.
const OVERRIDES = fieldOverrides(deploymentSessions, {
  deploymentId: { visible: false, filterable: false },
});

/** Each row's collect visit, kept per row object (rows keep identity across reads). */
const SESSIONS = new WeakMap<SessionRow, Session>();
function sessionOfRow(row: SessionRow): Session {
  let s = SESSIONS.get(row);
  if (s === undefined) {
    s = sessionOf(row);
    SESSIONS.set(row, s);
  }
  return s;
}

function searchText(row: SessionRow): string {
  const s = sessionOfRow(row);
  return [
    countryName(s.country),
    sourceOf(s),
    s.channel,
    s.device,
    s.os,
    s.browser,
    ...s.pages,
  ].join(" ");
}

/**
 * One click to narrow whose visits and on which kind of device — each option a
 * top-level rule of the active view's filter (every saved view starts on
 * Visitors), so a pick is a draft of the view, carried in the URL. No date
 * range: the list pages back through time as it scrolls.
 */
const QUICK_FILTERS: readonly QuickFilter[] = [
  {
    id: "whose",
    fieldId: "owner",
    label: "Whose visits",
    options: [
      {
        id: "visitors",
        label: "Visitors",
        rule: { operatorId: "is", value: false },
      },
      { id: "you", label: "You", rule: { operatorId: "is", value: true } },
      { id: "all", label: "All", rule: null },
    ],
  },
  {
    id: "device",
    fieldId: "device",
    label: "Device",
    options: [
      { id: "any", label: "Any device", rule: null },
      ...DEVICE_FAMILIES.map((d): QuickFilterOption => ({
        id: d.toLowerCase(),
        label: d,
        rule: { operatorId: "is", value: d },
      })),
    ],
  },
];

const VIEW_OPTIONS = {
  list: {
    renderRow: (row: SessionRow) => <SessionLane session={sessionOfRow(row)} />,
    detail: (row: SessionRow) => (
      <SessionTimeline session={sessionOfRow(row)} />
    ),
    detailOnActivate: true,
    frame: "card",
  },
} as const;

/** The loaded window handed to the surface, with what every lane shares. */
function VisitsBundle({
  render,
  rows,
  readiness,
  paging,
}: {
  render: DataViewSourceProps<SessionsHostProps>["render"];
  rows: readonly SessionRow[];
  readiness: ResourceReadiness;
  paging: Omit<DataViewPaging<SessionRow>, "isPaged"> | undefined;
}): ReactElement {
  const laneWindow = useLaneWindow(
    rows,
    readiness.status === "ready",
    paging?.total?.count ?? null,
  );
  return (
    <LaneWindowContext.Provider value={laneWindow}>
      {render<SessionRow>({
        rows,
        rowKey: rowKeyOf,
        collection: deploymentSessions,
        overrides: OVERRIDES,
        readiness,
        ...(paging !== undefined ? { paging } : {}),
        searchAccessor: searchText,
        quickFilters: QUICK_FILTERS,
        viewOptions: VIEW_OPTIONS,
        emptyState: <>No visit matches this view.</>,
      })}
    </LaneWindowContext.Provider>
  );
}

/** Everything the rows share, derived once per loaded window. */
function useLaneWindow(
  rows: readonly SessionRow[],
  known: boolean,
  total: number | null,
): LaneWindow {
  return useMemo<LaneWindow>(() => {
    const sessions = rows.map(sessionOfRow);
    const journeys = new Map<string, Journey>(
      sessions.map((s) => [s.id, journeyOf(s)]),
    );
    const all = [...journeys.values()];
    return {
      journeys,
      sections: sectionsByPath(all),
      axisMaxS: axisMaxS(Math.max(0, ...all.map((j) => j.durationS))),
      // Not known yet is no figure at all, never "0 sessions".
      summary: !known
        ? null
        : {
            total,
            loaded: sessions.length,
            medianS: median(all.map((j) => j.durationS)),
            // Over the visits whose load got ready on screen; none such → no figure.
            medianLoadMs: median(
              sessions.flatMap((s) => {
                const ready = visitLoad(s)?.readyMs ?? null;
                return ready === null ? [] : [ready];
              }),
            ),
            withActions: all.filter((j) => j.actionCount > 0).length,
          },
    };
  }, [rows, known, total]);
}
