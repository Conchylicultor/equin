import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  costDaily,
  costDistribution,
  costSessionsDaily,
  costTopSessions,
  sessionConversations,
} from "../../shared/values";
import {
  dailyAnswer,
  distributionAnswer,
  sessionsDailyAnswer,
  topSessionsAnswer,
} from "./answers";
import { loadBundle, watchCostInputs } from "./load-usage";

// The Stats → Cost values (interim — metrics P2 deletes them). Each answers
// one chart from the shared bundle (`loadBundle`, rebuilt once per input
// change), external `"notified"`: a subscribed tuple holds `watchCostInputs`
// (transcripts written, a price-table update, a capture). Transcript writes
// are coalesced at the source (`watchCostInputs`: one notify per 30 s window
// at most) — the charts are a day-granular history. No `throttleMs`: the
// runtime drains a throttled entry early whenever anything else flushes, so
// it bounds nothing here.

export const costDailyServed = serveValue(costDaily, {
  source: "external",
  changes: "notified",
  loader: async ({ scope }) => dailyAnswer(await loadBundle(), scope),
  whileSubscribed: (_params, notify) => watchCostInputs(notify),
});

export const costSessionsDailyServed = serveValue(costSessionsDaily, {
  source: "external",
  changes: "notified",
  loader: async ({ scope }) => sessionsDailyAnswer(await loadBundle(), scope),
  whileSubscribed: (_params, notify) => watchCostInputs(notify),
});

export const costDistributionServed = serveValue(costDistribution, {
  source: "external",
  changes: "notified",
  loader: async ({ scope }) => distributionAnswer(await loadBundle(), scope),
  whileSubscribed: (_params, notify) => watchCostInputs(notify),
});

export const costTopSessionsServed = serveValue(costTopSessions, {
  source: "external",
  changes: "notified",
  loader: async ({ scope }) => topSessionsAnswer(await loadBundle(), scope),
  whileSubscribed: (_params, notify) => watchCostInputs(notify),
});

/** A conversation by its Claude session id: routed point reads of `conversations`. */
export const sessionConversationsServed = serveCollection(
  sessionConversations,
  { from: _conversations },
);
