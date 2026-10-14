import { z } from "zod";
import { basename } from "path";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  type SpanDetail,
  type SpanKind,
  type SpanMeasures,
  SPAN_KINDS,
  waitSplit,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import { runtimeProfileSchema } from "../../shared/endpoints";

// The filter enum is SPAN_KINDS + the "all" sentinel, derived from the single
// source so a new kind never drifts out of the tool's filter (see SPAN_KINDS).
const KIND_FILTER = [...SPAN_KINDS, "all"] as const;

// This tool proxies to arbitrary worktree backends, which may still run code
// predating the wall-clock-decomposition fields. Backfill the missing numerics
// with 0 (never fabricated from other fields) so the shared wire schema still
// parses instead of crashing the tool on a stale target. A stale target also
// lacks any span kind added since (e.g. `route`/`membership`): those get an
// empty list — it recorded none, which is exactly what an empty list says.
const STALE_AGG_FIELDS = [
  "waitTotalMs",
  "childTotalMs",
  "selfTotalMs",
  "recentMaxMs",
  "maxAgeMs",
] as const;
const STALE_SPAN_FIELDS = ["waitMs", "childMs", "selfMs"] as const;

function backfillStaleProfile(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const profile = raw as {
    aggregates?: Record<string, Record<string, unknown>[]>;
    slowest?: Record<string, Record<string, unknown>[]>;
  };
  for (const byKind of [profile.aggregates, profile.slowest]) {
    if (!byKind) continue;
    for (const k of SPAN_KINDS) byKind[k] ??= [];
  }
  for (const rows of Object.values(profile.aggregates ?? {})) {
    for (const agg of rows) {
      for (const field of STALE_AGG_FIELDS) agg[field] ??= 0;
    }
  }
  for (const rows of Object.values(profile.slowest ?? {})) {
    for (const span of rows) {
      for (const field of STALE_SPAN_FIELDS) span[field] ??= 0;
    }
  }
  return raw;
}

export const runtimeProfileTool = Mcp.tool({
  name: "get_runtime_profile",
  description: `Slowest HTTP routes, DB queries, and live-state loaders in a worktree's server (in-memory window since last reset). Use to debug app/page slowness, N+1 patterns, and queueing/head-of-line blocking. Aggregates are sorted by \`recentMaxMs\` (max within a rolling ~5-min window — "is it slow NOW"); \`maxMs\` is the since-boot peak and \`maxAgeMs\` how long ago it was set, so an old spike reads as old instead of a live problem. Each db/loader aggregate includes a \`byParent\` breakdown attributing it to the enclosing request/loader that issued it, and each \`slowest\` span carries its immediate \`parent\`. Server-side only: browser-measured latency (a live update's change → applied, an optimistic write's dispatch → confirmed, page loads) is not here — read it in Debug → Slow Events or with \`get_timeline\`.

Kinds: \`http\` (routes; the span encloses the per-route dedupe/concurrency gates, so its wall-clock matches client-observed latency), \`db\` (queries + the pool \`[acquire]\` connect-wait), \`loader\` (live-state resource loads), the origin entries \`sub\` (a tab subscribed) / \`push\` (a notify cascade) that trigger loaders — a loader's \`parent\` names which one triggered it — and \`job\` (background queue jobs). \`flush\` is the live-state notify-flush cycle (\`flushNotifies\`): its \`byParent\` names which resource dominated a cycle (head-of-line), and \`push\` carries \`deliver:<key>\` leaves whose duration is the first-notify→send delivery latency (the "UI is stale" window) for that resource. \`cascade\` is a routed resource's reverse-route resolve — the id-translation read mapping a changed lookup row to the host ids that reference it — run inside the flush before the refill; its label is that resource's key (a dependsOn / recomputeOn cascade records no \`cascade\`: the downstream's recompute is a \`push\` load), and it is gated as background work (routes through \`background-acquire\`) but does not contribute to any resource's read-set. \`route\` is the change-feed routing one Postgres change into the runtime (label = the changed table; \`detail.measures.ids\` = changed ids, \`sinceChangeMs\` = trigger → routed, which includes how long the writing transaction stayed open). \`membership\` is a window resource's ids-only membership query (label = resource key), under its \`push\` origin. The live-state HTTP fallback shows as \`http\` \`GET /api/resources/<key>\` (304s included).

Detail: a span may carry \`detail.variant\` (which instance ran — a loader's canonical params) and \`detail.measures\` (\`subscribers\` / \`frameChars\` on \`deliver:<key>\`, and \`sinceChangeMs\` there when the change has a wall clock — change → send, which counts what the span's own first-notify → send duration cannot: a writing transaction held open, or a serving thread slow to read the NOTIFY; \`ids\` on a scoped refill loader or a route); each aggregate's \`measuresMax\` is the largest value of each measure across its records, so the widest fan-out / largest frame is visible even when no single span was slow.

Wall-clock decomposition: EVERY entry — including composite ones like \`flush\` — decomposes its per-call time into \`waitMs\` (time covered by named gate/pool waits at ANY depth of its subtree; gate waits propagate to every open ancestor as an interval UNION over the entry's own timeline, so waitMs ≤ wall even with many concurrent waiters), \`childMs\` (time covered by direct-child entries), and \`selfMs\` (the remainder — own orchestration; on composite spans a conservative upper bound of own work). The \`waits\` map names each gate layer's union ms. Reading a composite: a flush with \`childMs\` ≈ avg, \`waits\` naming \`background-acquire\`/\`db-acquire\`, and small \`selfMs\` spent its wall awaiting gate-blocked children — it did no work itself. Reading a leaf: mostly \`waitMs\` = head-of-line-blocked (the op itself is fast); mostly \`selfMs\` = genuinely slow.

Wait layers: \`background-acquire\` (per-backend background DB query gate slot; background = the chain's ROOT entry is flush/push/cascade/job, so a \`sub\`-origin loader never charges here), \`background-tx-acquire\` (background DB transaction lease gate — the \`pool.connect()\` a \`db.transaction()\` takes), \`db-acquire\` (pg pool connect), \`heavy-read-acquire\`/\`heavy-read-local\` (host-wide heavy git/fs read slots), \`read-admit\` (resource read admission), \`read-coalesce\` (joined an in-flight resource read), \`endpoint-concurrency\` (per-route concurrency gate), \`endpoint-dedupe\` (joined an in-flight identical GET — joiners show endpoint-dedupe ≈ wall, selfMs ≈ 0), \`git-coalesce:<name>\` (joined an in-flight git recompute), \`git-memo-hit:<name>\`/\`git-memo-miss:<name>\` (0ms markers — memo hit-rate, not blocking).

Default: profiles the current conversation's worktree server. Pass \`worktree\` to target a different worktree (e.g. "att-1778089188-7uvf" or "singularity" for main).`,
  inputSchema: {
    kind: z
      .enum(KIND_FILTER)
      .optional()
      .describe('Span kind to filter. Defaults to "all".'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max rows per kind. Defaults to 15."),
    worktree: z
      .string()
      .optional()
      .describe(
        "Target worktree name. Defaults to the conversation's own worktree.",
      ),
  },
  async handler({ kind = "all", limit = 15, worktree }, { conversationId }) {
    let raw: string;
    if (worktree) {
      raw = worktree;
    } else {
      const conv = await getConversation(conversationId);
      if (!conv) throw new Error(`Unknown conversation "${conversationId}"`);
      raw = basename(conv.worktreePath);
    }

    // A tool argument is a serialization boundary, and the name goes into a URL
    // the gateway resolves — so it is validated against the one grammar the
    // gateway itself accepts, not a local approximation of it.
    const worktreeName = asNamespace(raw);

    // Always read the profile through the gateway, which only ever proxies to
    // the worktree's live backend (`w.active`). Reading this process's own
    // in-memory recorder would silently report a stale/orphaned process
    // generation after a hot-swap restart.
    const url = namespaceUrl(worktreeName, "/api/debug/profiling/runtime");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `runtime profile fetch failed (${res.status}) for worktree "${worktreeName}"`,
      );
    }
    const profile = runtimeProfileSchema.parse(
      backfillStaleProfile(await res.json()),
    );
    const targetKinds: readonly SpanKind[] =
      kind === "all" ? SPAN_KINDS : [kind as SpanKind];

    interface ParentRow {
      parentKind: SpanKind;
      parentLabel: string;
      count: number;
      avgMs: number;
      maxMs: number;
    }
    const result: Record<
      string,
      {
        aggregates: {
          label: string;
          count: number;
          avgMs: number;
          waitMs: number;
          childMs: number;
          selfMs: number;
          maxMs: number;
          maxAgeMs: number;
          recentMaxMs: number;
          lastMs: number;
          waits?: Record<string, number>;
          measuresMax?: SpanMeasures;
          byParent: ParentRow[];
        }[];
        slowest: {
          label: string;
          durationMs: number;
          waitMs: number;
          childMs: number;
          selfMs: number;
          atMs: number;
          parent: { kind: SpanKind; label: string } | null;
          waits?: Record<string, number>;
          detail?: SpanDetail;
        }[];
      }
    > = {};

    for (const k of targetKinds) {
      result[k] = {
        aggregates: profile.aggregates[k].slice(0, limit).map((agg) => {
          // Per-call wall-clock decomposition: avg = wait (gate unions) +
          // child (direct-child unions, overlapping waits) with selfMs the
          // remainder — a high avgMs with a high waitMs/low selfMs is
          // head-of-line blocking, not a slow resource.
          const ws = waitSplit(agg);
          return {
            label: agg.label,
            count: agg.count,
            avgMs: Math.round(ws.avgMs),
            waitMs: Math.round(ws.waitMs),
            childMs: Math.round(ws.childMs),
            selfMs: Math.round(ws.selfMs),
            maxMs: agg.maxMs,
            maxAgeMs: Math.round(agg.maxAgeMs),
            recentMaxMs: agg.recentMaxMs,
            lastMs: agg.lastMs,
            waits: agg.waits,
            measuresMax: agg.measuresMax,
            byParent: agg.byParent.map((pb) => ({
              parentKind: pb.parent.kind,
              parentLabel: pb.parent.label,
              count: pb.count,
              avgMs: Math.round(pb.totalMs / pb.count),
              maxMs: pb.maxMs,
            })),
          };
        }),
        slowest: profile.slowest[k].slice(0, limit).map((s) => ({
          label: s.label,
          durationMs: s.durationMs,
          waitMs: s.waitMs,
          childMs: s.childMs,
          selfMs: s.selfMs,
          atMs: s.atMs,
          parent: s.parent,
          waits: s.waits,
          detail: s.detail,
        })),
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { sinceMs: profile.sinceMs, kinds: result },
            null,
            2,
          ),
        },
      ],
    };
  },
});
