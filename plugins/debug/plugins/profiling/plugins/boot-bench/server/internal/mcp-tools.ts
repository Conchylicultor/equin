import { z } from "zod";
import { basename } from "path";
import { extractPath } from "@plugins/infra/plugins/endpoints/core";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  bootBenchRun,
  bootBenchRunResponseSchema,
  type BootBenchRunBody,
} from "../../shared/endpoints";
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import { buildReport } from "./aggregate";

export const benchmarkBootTool = Mcp.tool({
  name: "benchmark_boot",
  description: `Repeatable cold-cache benchmark of the boot burst + live-state loaders in a worktree's RUNNING backend (no restart). Forces a truly cold boot by DELETING the L2 persisted snapshot rows for the boot-critical keys immediately before each cold iteration, so the boot-snapshot endpoint must recompute from loaders.

Measures, per iteration, all in the target process (so the event-loop histogram and the loaders share one process — no network noise in the measured window):
- boot-snapshot total time, per-key { source: memory|persisted|loader, workMs }, AND \`persistedReadMs\` (the single batched L2 read; persisted per-key workMs is that read amortized ÷ N — directional, not per-key truth).
- edited-files first-subscribe latency (onFirstSubscribe + loader) for the conversation fixture.
- commits-graph (.delta / .graph) first-subscribe latency for the attempt fixture.
- event-loop lag (max) during the burst.
- runtimeProfile.loaders AND runtimeProfile.db: every loader/db aggregate touched, each decomposed per call into \`waits\` (per-call amortized wait union by gate layer, e.g. \`heavy-read-acquire\` / \`heavy-read-local\` — each ≤ wall), \`childMs\` (direct-child entry union), and \`selfMs\` (own work: wall − union(waits ∪ children)). A high \`avgMs\` with a high wait / low \`selfMs\` is head-of-line blocking, NOT a slow op — this is the signal the contention root cause needs. Cross-reference: \`firstSubscribe[key].loaderMs\` is the end-to-end load latency; \`loaders[key].selfMs\` + its \`waits\` is the SAME number split into work vs wait.

Scope = live-server cold: it deliberately EXCLUDES server-boot work (catch-up, derived-table rebuild, pool warm), which is noisier. Run on an idle backend for clean cold numbers (a concurrent flushNotifies can re-persist rows mid-run).

warm mode runs BEFORE any cold-clear (the snapshot is naturally warm on a running backend); cold per-key sources should be all "loader" (cold mode bypasses the in-memory alias path) and warm mostly "memory"/"persisted" and faster. Discards the first \`warmup\` iterations of each set (GC settle). Returns per-mode { min, median, p95 } aggregates plus the resolved fixtures; the agent saves a baseline run and compares the after run itself.

BLOAT: \`snapshotBloat.{cold,warm}\` reports the \`live_state_snapshot\` table's { tableBytes, deadTuples, liveTuples }, captured ONCE per mode at the start of its set. The persisted-read cost only reproduces against REAL dead-tuple bloat — i.e. warm mode against an already-bloated DB (run with \`worktree: "singularity"\` to hit main). Cold-clearing DELETEs churn the very table being measured, so a fresh worktree shows misleadingly low bloat + low \`persistedReadMs\`; the bloat is captured before any cold delete so it reflects the pre-run state.

BYTES: \`snapshotBytes.{cold,warm}\` reports the boot snapshot's size as the endpoint serializes it, captured ONCE per mode beside its bloat (outside the timed burst): \`total\` { raw, gzip } of the whole body, \`perKey\` { raw, gzip } of each key's value (gzip at level 6, comparable with \`gzip -6\` on a curl of /api/resources/boot-snapshot), and \`rowKeyBytes\` — for each key whose rows carry the server-minted row key (\`$key\`) — the mean bytes that member adds to one row. Multiply it by a deployment's row count for what the row key costs that key there (e.g. this worktree's per-row figure × main's preloaded row counts, since a worktree's own rows may be few).

LOAD: \`loadConcurrency\` > 0 saturates the HOST-WIDE \`heavy-read\` gate with that many slot-holders during the burst, deterministically manufacturing the cross-worktree storm that serializes loaders. It contends with OTHER live worktrees for the duration of the run (realistic, bounded, auto-released). Use ≥ the host slot count to fully saturate; \`load.peakGateWaitMs\` (per mode) then rises materially vs an isolated run, proving the gate is contended. Default 0 = isolated.

Default: benchmarks the current conversation's worktree server. Pass \`worktree\` to target a different worktree (e.g. "att-1778089188-7uvf" or "singularity" for main). Pass \`conversationId\`/\`attemptId\` to pin the exact same fixtures across a before/after pair.`,
  inputSchema: {
    iterations: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Recorded iterations per mode (after warmup). Defaults to 10."),
    warmup: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Discarded warmup iterations per mode. Defaults to 2."),
    mode: z
      .enum(["cold", "warm", "both"])
      .optional()
      .describe('Which sets to run. Defaults to "both".'),
    conversationId: z
      .string()
      .optional()
      .describe(
        "Pin the edited-files conversation fixture (else auto-resolved).",
      ),
    attemptId: z
      .string()
      .optional()
      .describe("Pin the commits-graph attempt fixture (else auto-resolved)."),
    loadConcurrency: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Slot-holders to saturate the HOST-WIDE `heavy-read` gate during the burst (contends with other live worktrees for the run). Use ≥ the host slot count to fully saturate. Default 0 = isolated.",
      ),
    worktree: z
      .string()
      .optional()
      .describe(
        "Target worktree name. Defaults to the conversation's own worktree.",
      ),
  },
  async handler(
    {
      iterations,
      warmup,
      mode,
      conversationId,
      attemptId,
      loadConcurrency,
      worktree,
    },
    { conversationId: ctxConversationId },
  ) {
    let raw: string;
    if (worktree) {
      raw = worktree;
    } else {
      const conv = await getConversation(ctxConversationId);
      if (!conv) throw new Error(`Unknown conversation "${ctxConversationId}"`);
      raw = basename(conv.worktreePath);
    }

    // A tool argument is a serialization boundary, and the name goes into a URL
    // the gateway resolves — so it is validated against the one grammar the
    // gateway itself accepts, not a local approximation of it.
    const worktreeName = asNamespace(raw);

    // Always run the benchmark through the gateway, which only ever proxies to
    // the worktree's live backend (`w.active`). Running it in this process's own
    // runtime would benchmark a stale/orphaned process generation after a
    // hot-swap restart, and clear the wrong DB's snapshot.
    const reqBody: BootBenchRunBody = {
      iterations,
      warmup,
      mode,
      conversationId,
      attemptId,
      loadConcurrency,
    };
    const url = namespaceUrl(worktreeName, extractPath(bootBenchRun.route));
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    if (!res.ok) {
      throw new Error(
        `boot-bench run failed (${res.status}) for worktree "${worktreeName}"`,
      );
    }
    const response = bootBenchRunResponseSchema.parse(await res.json());
    const report = buildReport(response);

    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  },
});
