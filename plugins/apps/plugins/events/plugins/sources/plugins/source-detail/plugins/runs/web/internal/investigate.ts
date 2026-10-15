import { Investigate } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import {
  EVENTS_CATEGORY_ID,
  eventSourceRuns,
  type EventSourceRunRow,
} from "@plugins/apps/plugins/events/plugins/events-core/core";

/**
 * A failed source run's Investigate action, in every list of the run ledger:
 * an agent briefed on the run (its error verbatim, its counts) and where to
 * dig — the source row, the ledger row, the model call behind it.
 */
export const investigateSourceRuns = Investigate.Register<EventSourceRunRow>({
  owner: eventSourceRuns,
  failed: (run) => run.outcome === "failed",
  noun: "source run",
  categoryId: EVENTS_CATEGORY_ID,
  subject: (run) => ({ kind: "event-source-run", id: run.id }),
  description: () =>
    "Launch an agent briefed on this failed Events source run — its error verbatim, its counts, and where to dig.",
  brief: (run, userText) => {
    const extra = userText.trim();
    return [
      "## Investigate a failed Events source run",
      "",
      `A refresh of Events source \`${run.sourceId}\` failed.`,
      "",
      "**The run**",
      "",
      `- run id: \`${run.id}\` (a row in \`event_source_runs\`)`,
      `- started: ${run.startedAt.toISOString()}`,
      `- finished: ${run.finishedAt ? run.finishedAt.toISOString() : "never recorded"}`,
      `- took: ${run.durationMs ?? "unknown"} ms`,
      "",
      ...(run.error
        ? ["**The error**, verbatim:", "", "```", run.error, "```", ""]
        : ["The run recorded no error.", ""]),
      "**Where to dig**",
      "",
      `- the source row: \`select * from event_sources where id = '${run.sourceId}'\` via \`query_db\` (its type, config and classified error);`,
      `- the run row: \`select * from event_source_runs where id = '${run.id}'\`;`,
      "- the run pane (Events → Sources → this source → Runs → this run) shows its model call, if the extraction reached one;",
      "- the source type's probe / extract live in `plugins/apps/plugins/events/plugins/sources/plugins/<type>`; the engine in `plugins/apps/plugins/events/plugins/refresh`.",
      "",
      "Find the root cause and say what it is. Fix it if the fix is clearly in this repo; if the site changed, say what changed.",
      ...(extra ? ["", "## What the user asked for", "", extra] : []),
    ].join("\n");
  },
});
