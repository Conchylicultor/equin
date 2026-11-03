import { sql } from "drizzle-orm";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { expr } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import {
  CLAUDE_CLI_RING_ID,
  claudeCliCallHorizon,
  claudeCliCalls,
  claudeCliCallsByRecord,
  claudeCliCallsFor,
  ClaudeCliCallStatusSchema,
  RECENT_CALLS_LIMIT,
  type ClaudeCliCallsResult,
} from "../../core/resources";
import { _claudeCliCallHorizon, _claudeCliCalls } from "./tables";
import { parseOccurredAt } from "./list-calls";
import { statusForNoCalls } from "./retention-verdict";

// The call log over `claude_cli_calls`: its window (newest first,
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

// The rows `claude-cli.calls-for` follows: one record's calls, and the ring
// horizon.
export const claudeCliCallsByRecordServed = serveCollection(
  claudeCliCallsByRecord,
  { from: _claudeCliCalls },
);
export const claudeCliCallHorizonServed = serveCollection(
  claudeCliCallHorizon,
  { from: _claudeCliCallHorizon },
);

// One record's calls (`claude-cli.calls-for`). It follows the record's own
// calls — a call recorded for it, or the trim aging one out, recomputes it;
// another record's calls reach none. Only while it has none, and its reader
// said when the record happened, does it follow the ring horizon
// (`follow.from` its calls, `null` otherwise): `none` and `not-retained` are
// told apart by where the ring stands (`statusForNoCalls`), which every call
// recorded anywhere moves.
export const claudeCliCallsForServed = serveValue(claudeCliCallsFor, {
  source: "db",
  follows: (follow) => {
    const calls = follow(claudeCliCallsByRecordServed, ({ correlationId }) => ({
      where: { correlationId },
    }));
    return {
      calls,
      horizon: follow.from(
        { calls },
        claudeCliCallHorizonServed,
        ({ occurredAt }, r) =>
          r.calls.length === 0 && occurredAt !== undefined
            ? { ids: [CLAUDE_CLI_RING_ID] }
            : null,
      ),
    };
  },
  loader: ({ occurredAt }, { followed }): ClaudeCliCallsResult => {
    const at = parseOccurredAt(occurredAt);
    if (followed.calls.length > 0) {
      return { status: "calls", calls: [...followed.calls] };
    }
    const ring = followed.horizon[0];
    return {
      status: statusForNoCalls({
        occurredAt: at,
        total: ring?.total ?? 0,
        oldest: ring?.oldest ?? null,
        limit: RECENT_CALLS_LIMIT,
      }),
    };
  },
});
