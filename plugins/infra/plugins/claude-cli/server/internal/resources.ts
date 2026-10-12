import { sql } from "drizzle-orm";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import {
  claudeCliCalls,
  claudeCliCallsFor,
  ClaudeCliCallStatusSchema,
} from "../../core/resources";
import { _claudeCliCalls } from "./tables";
import { listCallsFor, parseOccurredAt } from "./list-calls";

// The call log over `claude_cli_calls`: its scroll window (newest first,
// filterable / searchable — see the collection), its `:rows` point sibling and
// the `:groups` the pane's Source / Model facets read. The table row and
// `ClaudeCliCall` both derive from the single `claudeCliCallFields` record
// (core), so every stored field binds to its column by name; `status` is the
// one computed field — `error IS NOT NULL`, the same fact `error` states, so it
// cannot drift from it. A call is written once and never updated; the
// recorder's trim to `RECENT_CALLS_LIMIT` is a window delete.
export const claudeCliCallsServed = serveCollection(claudeCliCalls, {
  from: _claudeCliCalls,
  columns: {
    status: (j) =>
      expr(
        sql`(CASE WHEN ${j.base.error} IS NULL THEN 'ok' ELSE 'error' END)`,
        {
          decoder: parsed(ClaudeCliCallStatusSchema, "claude-cli-calls.status"),
          sqlType: "text",
          notNull: true,
        },
      ),
  },
});

// One record's calls (`claude-cli.calls-for`): the loader reads only
// `claude_cli_calls`, so a call recorded for the record — or the recorder's
// trim aging one out, which can flip `none` to `not-retained` — recomputes the
// subscribed tuples through the change feed. The log is a ring of
// `RECENT_CALLS_LIMIT` rows written once per model call, so recomputing every
// open tuple on each insert stays cheap.
export const claudeCliCallsForServed = serveValue(claudeCliCallsFor, {
  source: "db",
  loader: ({ correlationId, occurredAt }) =>
    listCallsFor(correlationId, parseOccurredAt(occurredAt)),
});
