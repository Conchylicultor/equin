import { db } from "@plugins/database/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { _claudeUsageSources } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  costConversations,
  costDaily,
  costDistribution,
  costSessionsDaily,
  costTopSessions,
} from "../../shared/values";
import {
  dailyAnswer,
  distributionAnswer,
  sessionsDailyAnswer,
  topSessionsAnswer,
} from "./answers";
import { _claudeSpendDays, _claudeSpendSources } from "./tables";

// The Stats → Cost values (interim — metrics P2 deletes them). Each answers
// one chart with SQL over the two rollups of the priced token ledger
// (`./answers.ts`; kept by the database, `./rollups.ts`), served `"db"`: a
// ledger write (a usage-sync pass, a CLI call), a price correction or a
// source's repo flag re-aggregates only the days and sources it moved, and the
// change feed on the rollups (guarded upserts: only when a number moved) and
// on the sources' rows recomputes every subscribed tuple. Each recompute reads
// the rollups — a few rows per day of use, one per session — never the ledger.
const reads = {
  tables: [_claudeSpendDays, _claudeSpendSources, _claudeUsageSources],
  reason:
    "every day and every session of the priced ledger's rollups, scoped by the source's repo flag — the charts are the whole history",
};

export const costDailyServed = serveValue(costDaily, {
  source: "db",
  reads,
  loader: ({ scope }) => dailyAnswer(db, scope),
});

export const costSessionsDailyServed = serveValue(costSessionsDaily, {
  source: "db",
  reads,
  loader: ({ scope }) => sessionsDailyAnswer(db, scope),
});

export const costDistributionServed = serveValue(costDistribution, {
  source: "db",
  reads,
  loader: ({ scope }) => distributionAnswer(db, scope),
});

export const costTopSessionsServed = serveValue(costTopSessions, {
  source: "db",
  reads,
  loader: ({ scope }) => topSessionsAnswer(db, scope),
});

/** A top session's live conversation by id: routed point reads of `conversations`. */
export const costConversationsServed = serveCollection(costConversations, {
  from: _conversations,
});
