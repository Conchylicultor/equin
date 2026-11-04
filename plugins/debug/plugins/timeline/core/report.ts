import { TimelineSeveritySchema, TimelineSourceSchema } from "./model";
import type { TimelineSeverity, TimelineSource } from "./model";

// The get_timeline text report as a format + read pair. The server renders it
// (server/internal/render.ts, which spells the header, the stats line, the
// section headings and the event lines through the functions below); the
// transcript renderer reads it back with readTimelineReport. Both ends share
// these definitions, so a change to the layout cannot drift apart from its
// reader; report.test.ts pins the round trip.

/** The report's sections in order; a heading is the line that starts one. */
export const TIMELINE_SECTIONS = [
  {
    id: "duress",
    heading: "DURESS  (host-global — signal is thinned inside these)",
  },
  { id: "host-pressure", heading: "HOST PRESSURE (peak)" },
  { id: "backend-health", heading: "BACKEND HEALTH (peak event-loop p99)" },
  { id: "events", heading: "EVENTS" },
  { id: "chunk-errors", heading: "CHUNK ERRORS (data missing here)" },
] as const;

export type TimelineSectionId = (typeof TIMELINE_SECTIONS)[number]["id"];

export function timelineHeading(id: TimelineSectionId): string {
  return TIMELINE_SECTIONS.find((s) => s.id === id)!.heading;
}

export interface TimelineHeader {
  /** The window's ends, already in the report's local time. */
  from: string;
  to: string;
  tz: string;
  /** The window's length in words ("14m 00s"). */
  window: string;
  scanned: number;
  events: number;
  duress: number;
  healthLanes: number;
  chunkErrors: number;
}

export function formatTimelineHeader(h: TimelineHeader): string[] {
  return [
    `TIMELINE  ${h.from} → ${h.to}  (${h.tz})`,
    `window ${h.window} · scanned ${h.scanned} chunks · ` +
      `${h.events} events · ${h.duress} duress · ` +
      `${h.healthLanes} health lanes · ${h.chunkErrors} chunk errors`,
  ];
}

const SEVERITY_TAG: Record<TimelineSeverity, string> = {
  info: "INFO ",
  warning: "WARN ",
  error: "ERROR",
};

export interface TimelineReportEvent {
  /** Local start time, as the report spells it. */
  time: string;
  severity: TimelineSeverity;
  source: TimelineSource;
  worktree: string;
  /** May span lines (a slow SQL statement). */
  label: string;
  traceId?: string;
}

export function formatTimelineEvent(e: TimelineReportEvent): string {
  const trace = e.traceId ? `  trace=${e.traceId}` : "";
  return `  ${e.time} [${SEVERITY_TAG[e.severity]}] ${e.source}  ${e.worktree}  ${e.label}${trace}`;
}

export interface TimelineReportSection {
  id: TimelineSectionId;
  /** The section's lines, indentation kept, blank lines dropped. */
  lines: string[];
}

export interface TimelineReport {
  from: string;
  to: string;
  tz: string;
  window: string;
  scanned: number;
  /** Events found in the window, before severity and the cap. */
  events: number;
  duress: number;
  healthLanes: number;
  chunkErrors: number;
  sections: TimelineReportSection[];
  /** The EVENTS section's event lines. */
  shown: TimelineReportEvent[];
  /** The line naming what the cap or the severity floor left out. */
  dropped: string | undefined;
}

export type TimelineRead =
  { kind: "report"; report: TimelineReport } | { kind: "unreadable" };

const TITLE = /^TIMELINE {2}(.+) → (.+) {2}\((.+)\)$/;
const STATS =
  /^window (.+) · scanned (\d+) chunks · (\d+) events · (\d+) duress · (\d+) health lanes · (\d+) chunk errors$/;
const EVENT = /^ {2}(\S+) \[(INFO |WARN |ERROR)\] (\S+) {2}(\S+) {2}([\s\S]*)$/;
const DROPPED = /^ {2}dropped \(/;

const SEVERITY_OF_TAG: Record<string, TimelineSeverity> = {
  "INFO ": "info",
  "WARN ": "warning",
  ERROR: "error",
};

function readEvents(lines: readonly string[]): {
  events: TimelineReportEvent[];
  dropped: string | undefined;
} {
  const events: TimelineReportEvent[] = [];
  let dropped: string | undefined;
  // A label can run over several lines (a SQL statement), so an event is its
  // first line plus every line after it that starts no other event.
  let open: string[] | undefined;
  const close = () => {
    if (!open) return;
    const m = EVENT.exec(open.join("\n"))!;
    const body = m[5]!;
    const trace = /^([\s\S]*?) {2}trace=(\S+)$/.exec(body);
    const severity = TimelineSeveritySchema.parse(SEVERITY_OF_TAG[m[2]!]);
    const source = TimelineSourceSchema.parse(m[3]);
    events.push({
      time: m[1]!,
      severity,
      source,
      worktree: m[4]!,
      label: trace ? trace[1]! : body,
      ...(trace ? { traceId: trace[2]! } : {}),
    });
    open = undefined;
  };
  for (const line of lines) {
    if (DROPPED.test(line)) {
      close();
      dropped = line.trim();
    } else if (isEventStart(line)) {
      close();
      open = [line];
    } else if (open) {
      open.push(line);
    }
  }
  close();
  return { events, dropped };
}

function isEventStart(line: string): boolean {
  const m = EVENT.exec(line);
  return m !== null && TimelineSourceSchema.safeParse(m[3]).success;
}

/** Reads a report back; anything that is not one (a failure message) is `unreadable`. */
export function readTimelineReport(text: string): TimelineRead {
  const [titleLine = "", statsLine = "", ...rest] = text.split("\n");
  const title = TITLE.exec(titleLine);
  const stats = STATS.exec(statsLine);
  if (!title || !stats) return { kind: "unreadable" };

  const sections: TimelineReportSection[] = [];
  for (const line of rest) {
    if (line.trim() === "") continue;
    const section = TIMELINE_SECTIONS.find((s) => line === s.heading);
    if (section) sections.push({ id: section.id, lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  const { events, dropped } = readEvents(
    sections.find((s) => s.id === "events")?.lines ?? [],
  );
  return {
    kind: "report",
    report: {
      from: title[1]!,
      to: title[2]!,
      tz: title[3]!,
      window: stats[1]!,
      scanned: Number(stats[2]),
      events: Number(stats[3]),
      duress: Number(stats[4]),
      healthLanes: Number(stats[5]),
      chunkErrors: Number(stats[6]),
      sections,
      shown: events,
      dropped,
    },
  };
}
