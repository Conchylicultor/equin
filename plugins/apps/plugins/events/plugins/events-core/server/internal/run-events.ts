import type { RunEvent, RunEventAction } from "../../core";

/** The rows `events.run-events` follows, as its loader is handed them. */
interface RunEventsFollowed {
  readonly links: readonly { eventId: string; action: RunEventAction }[];
  readonly events: readonly Omit<
    RunEvent,
    "action" | "sourceType" | "sourceConfig"
  >[];
  readonly sources: readonly {
    id: string;
    type: RunEvent["sourceType"];
    config: RunEvent["sourceConfig"];
  }[];
}

/**
 * The events one run touched, each carrying what that run did to it and its
 * source's ref, ordered by when the event happens (id breaks a tie), at most
 * `limit` — the followed rows joined as the old SQL joined them: a link whose
 * event, or an event whose source, is gone is not listed.
 */
export function runEventsOf(
  followed: RunEventsFollowed,
  limit: number,
): RunEvent[] {
  // Keyed by the ids' text: a link names its event by plain text.
  const events = new Map<string, RunEventsFollowed["events"][number]>(
    followed.events.map((e) => [e.id, e]),
  );
  const sources = new Map<string, RunEventsFollowed["sources"][number]>(
    followed.sources.map((s) => [s.id, s]),
  );
  const out: RunEvent[] = [];
  for (const link of followed.links) {
    const event = events.get(link.eventId);
    const source = event && sources.get(event.sourceId);
    if (!event || !source) continue;
    out.push({
      ...event,
      action: link.action,
      sourceType: source.type,
      sourceConfig: source.config,
    });
  }
  out.sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out.slice(0, limit);
}
