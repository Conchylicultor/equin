import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { recordMcpContribution } from "./health";

/** One contribution's outcome: its value, or the failure it was confined to. */
export type ContributionOutcome<T> =
  { ok: true; value: T } | { ok: false; message: string };

/**
 * Runs one contribution's per-connection callback (an instructions section, a
 * live description, a `when` gate) so its failure stays its own: a throw is
 * reported (server log + a `crash` report through server-core's error
 * reporter) and returned as the failed arm, which the caller must render in
 * place of the contribution. It never fails the request — every other tool and
 * section of the connection is unaffected.
 *
 * Either way the outcome is recorded for the health value (`mcp.health`):
 * a throw lists the contribution as degraded until it next runs cleanly.
 *
 * `what` names the contribution in the report, e.g. `instructions section
 * "tree-digest"`.
 */
export async function runContribution<T>(
  what: string,
  run: () => T | Promise<T>,
): Promise<ContributionOutcome<T>> {
  let value: T;
  try {
    value = await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordMcpContribution(what, { ok: false, message });
    console.error(`[mcp] ${what} failed:`, err);
    reportServerError({
      message: `MCP ${what} failed: ${message}`,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return { ok: false, message };
  }
  recordMcpContribution(what, { ok: true });
  return { ok: true, value };
}
