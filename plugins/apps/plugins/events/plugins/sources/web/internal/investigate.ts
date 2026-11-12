import { Investigate } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import {
  EVENTS_CATEGORY_ID,
  eventSources,
} from "@plugins/apps/plugins/events/plugins/events-core/core";

/**
 * A source in Error's Investigate action, in every list of the sources: an
 * agent briefed on the source (its classified error verbatim, its last run)
 * and where to dig — the run ledger first, where each failed refresh is
 * recorded (and investigated on its own, `investigateSourceRuns`).
 */
export const investigateSources = Investigate.Register({
  owner: eventSources,
  failed: (source) => source.status === "error",
  noun: "source",
  categoryId: EVENTS_CATEGORY_ID,
  subject: (source) => ({ kind: "event-source", id: source.id }),
  description: () =>
    "Launch an agent briefed on this failing Events source — its error verbatim, its last run, and where to dig.",
  brief: (source, userText) => {
    const extra = userText.trim();
    return [
      "## Investigate a failing Events source",
      "",
      `Events source \`${source.id}\` (${source.name}, type \`${source.type}\`) is in Error: its last refresh failed.`,
      "",
      `- last run: ${source.lastRunAt ? source.lastRunAt.toISOString() : "never recorded"}`,
      ...(source.lastErrorCode
        ? [`- error code: \`${source.lastErrorCode}\``]
        : []),
      "",
      ...(source.lastError
        ? ["**The error**, verbatim:", "", "```", source.lastError, "```", ""]
        : ["The source recorded no error message.", ""]),
      "**Where to dig**",
      "",
      `- the source row: \`select * from event_sources where id = '${source.id}'\` via \`query_db\`;`,
      `- its runs, newest first: \`select * from event_source_runs where source_id = '${source.id}' order by started_at desc limit 10\` — when did it start failing, and with what;`,
      "- the source pane (Events → Sources → this source → Runs) shows each run's model call, if the extraction reached one;",
      "- the source type's probe / extract live in `plugins/apps/plugins/events/plugins/sources/plugins/<type>`; the engine in `plugins/apps/plugins/events/plugins/refresh`.",
      "",
      "Find the root cause and say what it is. Fix it if the fix is clearly in this repo; if the site changed, say what changed.",
      ...(extra ? ["", "## What the user asked for", "", extra] : []),
    ].join("\n");
  },
});
