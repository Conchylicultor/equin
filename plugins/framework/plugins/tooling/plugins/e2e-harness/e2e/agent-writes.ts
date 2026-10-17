/**
 * Undoing the durable writes an e2e run made.
 *
 * Some UI state is written straight into the user's durable data: a DataView
 * writes its per-view-instance sort / filter / groupBy back through config_v2,
 * a prototype's option picker writes the shared picks record. So a script that
 * clicks "Group by Kind" to verify grouping works leaves the running surface
 * grouped for the user — and poisons its own next run's baseline, which is how
 * this was found: a "0 expanded elements" baseline became 44, the assertion saw
 * 44 → 44 and failed, and it looked exactly like a product bug.
 *
 * The server records the pre-write bytes of everything a request carrying the
 * agent-origin header overwrites, in one ledger per domain (`withBrowser` stamps
 * that header on every context, so every script and every ad-hoc
 * `screenshot.ts --click` drive is marked). This module is the harness half:
 * ask for every e2e run's writes back, at both ends of every run. It names no domain — the
 * two routes aggregate every registered ledger, so a new one is covered here
 * with no change.
 *
 * Design: `research/2026-08-30-global-agent-config-write-revert-ledger.md`,
 * generalized in `research/2026-09-16-global-shared-prototype-option-picks.md`.
 */
import type { Codec } from "@plugins/infra/plugins/endpoints/core";
import {
  agentWrites,
  revertAgentWrites,
  type AgentWritesScope,
} from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/core";
import { agentFetch } from "./app-fetch";

/**
 * Every e2e run's writes — its sources are `e2e:<script>` (`originSource`) —
 * and nothing else: an agent's live browser session writing to the same deploy
 * (`mcp-browser:<conversationId>`) reverts its own when it closes.
 */
const E2E_WRITES: AgentWritesScope = { scope: "prefix", prefix: "e2e" };
import { waitFor } from "./wait";
import { pushDiagnostic } from "./diagnostics";

/**
 * Call an endpoint by its own definition rather than a retyped route string,
 * and decode the answer through the endpoint's own response schema.
 *
 * Raw `fetch("/api/…")` is banned in `/web/` only, so `e2e` is free to do this
 * — but the route still comes from the contract, so a renamed endpoint is a
 * type error here instead of a 404 at run time.
 */
async function callEndpoint<T, B = never>(
  def: { method: string; path: string; responseCodec?: Codec<T> },
  phase: string,
  body?: B,
): Promise<T> {
  const res = await agentFetch(def.path, {
    method: def.method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[e2e] agent-write ${phase} failed: ${def.method} ${def.path} → HTTP ${res.status} ${body}\n` +
        `  If this is a 404, the deployed server predates the shared agent-write ledger —\n` +
        `  run \`./singularity build\` to redeploy this worktree.`,
    );
  }
  if (!def.responseCodec) {
    throw new Error(
      `[e2e] ${def.method} ${def.path} declares no response schema to decode.`,
    );
  }
  return def.responseCodec.decodeResponse(res);
}

/**
 * Wait for agent writes to stop arriving.
 *
 * ONLY meaningful after the browser is closed, and that ordering is the whole
 * point. A DataView's write-back is a 400 ms trailing debounce living in a
 * `setTimeout` inside the page: closing the context destroys the timer, which
 * bounds what can still reach the server to requests already dispatched. This
 * then drains those, so the revert does not race a write that is still in
 * flight.
 *
 * The poll interval is comfortably wider than the debounce plus a localhost
 * round trip. Quiet ledgers settle on the first read, so a run that wrote
 * nothing pays one request.
 */
export async function settleAgentWrites(): Promise<void> {
  let previous: string | null | undefined;
  await waitFor(
    async () => (await callEndpoint(agentWrites, "ledger read")).lastWriteAt,
    (now) => {
      const quiet = previous !== undefined && now === previous;
      previous = now;
      return quiet;
    },
    { timeoutMs: 5_000, intervalMs: 750 },
  );
}

/**
 * Restore everything this (or a previous) e2e run overwrote, in every ledger.
 *
 * Throws on `failed`, which is what stops a run going green having left the
 * user's data changed. `diverged` is NOT a failure: it means someone edited the
 * thing after the agent did, so the server deliberately left their edit alone —
 * the script did nothing wrong, and a diagnostic is the honest report.
 */
export async function repairAgentWrites(phase: "start" | "end"): Promise<void> {
  const out = await callEndpoint(
    revertAgentWrites,
    `${phase} revert`,
    E2E_WRITES,
  );

  if (out.failed.length > 0) {
    throw new Error(
      `[e2e] ${phase} revert could not restore ${out.failed.length} agent write(s):\n` +
        out.failed
          .map((f) => `  ${f.label}: ${f.key} — ${f.message}`)
          .join("\n"),
    );
  }

  for (const d of out.diverged) {
    pushDiagnostic(
      `${d.label}: ${d.key} was edited after the agent wrote it — left as found (${d.detail})`,
    );
  }

  // Worth a line: at "start" it means a previous run died before its own
  // revert, which is exactly the case a teardown could never have covered.
  if (out.reverted.length > 0) {
    const what = out.reverted.map((r) => `${r.label}: ${r.key}`).join(", ");
    console.log(
      phase === "start"
        ? `      repaired ${out.reverted.length} agent write(s) left by a previous run: ${what}`
        : `      reverted ${out.reverted.length} agent write(s) made by this run: ${what}`,
    );
  }
}
