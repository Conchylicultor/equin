import {
  averageTimeOnPageMs,
  bounceRate,
  conversionRate,
  parseEventPropValue,
  visitorShare,
  type AnalyticsReport,
  type Dimension,
  type ReportRow,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { IP_COUNTRY_SOURCE } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country/core";
import {
  formatAverage,
  formatDurationMs,
  formatPercent,
  orDash,
} from "./format";

/** One numeric column of a ranked list. */
export interface PanelColumn {
  label: string;
  /** Rendered text for a row. */
  cell: (row: ReportRow, report: AnalyticsReport) => string;
}

export interface PanelTab {
  id: string;
  label: string;
  dimension: Dimension;
  /** The count the row's bar is proportional to, and its column. */
  primary: { label: string; value: (row: ReportRow) => number };
  /** The columns after the primary one. */
  columns: readonly PanelColumn[];
  /**
   * The finer rows a row expands into, grouped (an event's props, one group per
   * key). A row with no group has no expander.
   */
  breakdown?: (row: ReportRow, report: AnalyticsReport) => readonly Breakdown[];
  note?: string;
  /** Who the tab's data comes from, credited (with a link) after the note. */
  credit?: DataCredit;
}

/** One group of a row's breakdown: rows of another dimension, ranked. */
export interface Breakdown {
  /** "by card". */
  label: string;
  dimension: Dimension;
  rows: readonly ReportRow[];
  /** How a row of the group is named (the prop's value alone, not its full stored spelling). */
  rowLabel: (value: string) => string;
}

/** "IP geolocation by DB-IP (db-ip.com), CC BY 4.0." */
export interface DataCredit {
  /** What the source provides: "IP geolocation". */
  what: string;
  source: { name: string; url: string; license: string };
}

export interface PanelDef {
  id: string;
  title: string;
  tabs: readonly PanelTab[];
  /** Spans both columns of the panel grid. */
  wide?: true;
}

/** Times each visitor who fired the event fired it, on average. */
function eventsPerVisitor(row: ReportRow): number | null {
  return row.visitors > 0 ? row.events / row.visitors : null;
}

/** An event's `event_prop` rows, one group per prop key, in the server's rank order. */
function eventPropBreakdown(
  row: ReportRow,
  report: AnalyticsReport,
): Breakdown[] {
  const byKey = new Map<string, ReportRow[]>();
  for (const prop of report.rows.event_prop) {
    const { event, key } = parseEventPropValue(prop.value);
    if (event !== row.value) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), prop]);
  }
  return [...byKey].map(([key, rows]) => ({
    label: `by ${key}`,
    dimension: "event_prop",
    rows,
    rowLabel: (value) => parseEventPropValue(value).value,
  }));
}

const visitors = { label: "Visitors", value: (r: ReportRow) => r.visitors };
const share: PanelColumn = {
  label: "Share",
  cell: (row, report) =>
    orDash(visitorShare(row, report.current.summary), formatPercent),
};

/**
 * Exit rate of a page: the visits that left from it over the times it was
 * viewed. Its views live on the `page` row of the same path.
 */
function exitRate(row: ReportRow, report: AnalyticsReport): number | null {
  const page = report.rows.page.find((p) => p.value === row.value);
  return page && page.pageviews > 0 ? row.visits / page.pageviews : null;
}

export const PANELS: readonly PanelDef[] = [
  {
    id: "pages",
    title: "Pages",
    tabs: [
      {
        id: "top",
        label: "Top pages",
        dimension: "page",
        primary: visitors,
        columns: [
          {
            label: "Time on page",
            cell: (row) => orDash(averageTimeOnPageMs(row), formatDurationMs),
          },
        ],
      },
      {
        id: "entry",
        label: "Entry",
        dimension: "entry_page",
        primary: { label: "Visits", value: (r) => r.visits },
        columns: [
          {
            label: "Bounce",
            cell: (row) => orDash(bounceRate(row), formatPercent),
          },
        ],
      },
      {
        id: "exit",
        label: "Exit",
        dimension: "exit_page",
        primary: { label: "Exits", value: (r) => r.visits },
        columns: [
          {
            label: "Exit rate",
            cell: (row, report) => orDash(exitRate(row, report), formatPercent),
          },
        ],
      },
    ],
  },
  {
    id: "sources",
    title: "Sources",
    tabs: [
      {
        id: "channels",
        label: "Channels",
        dimension: "channel",
        primary: visitors,
        columns: [share],
        note: "Click a source to see which pages its visitors landed on.",
      },
      {
        id: "referrers",
        label: "Referrers",
        dimension: "referrer_host",
        primary: visitors,
        columns: [share],
      },
      {
        id: "campaigns",
        label: "Campaigns",
        dimension: "utm_campaign",
        primary: visitors,
        columns: [share],
        note: "From utm_* tags on the landing URL.",
      },
      {
        id: "linking",
        label: "Linking pages",
        dimension: "referrer_path",
        primary: visitors,
        columns: [share],
        note: "The exact page that linked, when the source sends it. Many sites send only their domain.",
      },
    ],
  },
  {
    id: "locations",
    title: "Locations",
    tabs: [
      {
        id: "countries",
        label: "Countries",
        dimension: "country",
        primary: visitors,
        columns: [share],
        note: "Looked up from the visitor's IP, which is not stored.",
        credit: { what: "IP geolocation", source: IP_COUNTRY_SOURCE },
      },
      {
        id: "languages",
        label: "Languages",
        dimension: "language",
        primary: visitors,
        columns: [share],
      },
    ],
  },
  {
    id: "devices",
    title: "Devices",
    tabs: [
      {
        id: "device",
        label: "Device",
        dimension: "device",
        primary: visitors,
        columns: [share],
      },
      {
        id: "browser",
        label: "Browser",
        dimension: "browser",
        primary: visitors,
        columns: [share],
      },
      {
        id: "os",
        label: "OS",
        dimension: "os",
        primary: visitors,
        columns: [share],
      },
    ],
  },
  {
    id: "events",
    title: "Events",
    wide: true,
    tabs: [
      {
        id: "events",
        label: "Custom events",
        dimension: "event",
        primary: { label: "Count", value: (r) => r.events },
        columns: [
          {
            label: "Per visitor",
            cell: (row) => orDash(eventsPerVisitor(row), formatAverage),
          },
          {
            label: "Conversion",
            cell: (row, report) =>
              orDash(
                conversionRate(row, report.current.summary),
                formatPercent,
              ),
          },
        ],
        breakdown: eventPropBreakdown,
        note: "Per visitor is how many times each visitor who fired the event fired it, on average. Conversion is the share of unique visitors who fired it at least once. Expand an event to break it down by its props.",
      },
    ],
  },
];
