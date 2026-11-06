import { defineCliCommand } from "@plugins/framework/plugins/cli/core";
import { OP_KIND_IDS } from "@plugins/infra/plugins/worktree/core";

/**
 * Block until this checkout's running op finishes, and say what it did.
 *
 * The op it waits on is NOT started here — `await` never spawns anything. The
 * op keeps running as whatever started it (a `run_in_background` Bash task, a
 * second terminal, the app's own build job); this command only watches, so
 * killing the wait kills nothing. That split is the point: a fused
 * "start-and-wait" would have to own the child, and the CLI's orphan guard
 * (see `defineCliCommand`'s `detachable`) then kills the op the moment its
 * invoking shell dies — which is precisely what happens when an agent's
 * foreground tool call hits its 10-minute cap.
 *
 * ## Why it exists
 *
 * A subagent that backgrounds a long op is never re-invoked when it finishes:
 * the harness files the completion notification under the PARENT session's
 * queue, where it sits undelivered (upstream anthropics/claude-code #88423,
 * #87689, #85534 — all open). Measured in conv-1789736383-4i30: two teammates
 * ended their turns on a background `check` and `test`, both finished with exit
 * 0 two minutes later, and nothing moved for nine hours.
 *
 * So the wake-up stops being something to be told and becomes a tool result.
 * The agent runs its op in the background as before, then calls this and holds
 * its turn open until the verdict lands.
 *
 * Not `detachable`: dying with its shell is exactly right for a wait.
 */
export default defineCliCommand<[string[]], { maxWait?: string; arm?: string }>(
  {
    name: "await",
    description:
      "Wait for this checkout's running op(s) to finish and print the verdict. Starts " +
      "nothing and kills nothing — it watches the op marker and the op log, and returns " +
      "the moment a verdict is written. Exit 0 = all succeeded, 1 = one failed (or died " +
      "without a verdict), 70 = still running when the wait capped (call it again), " +
      "3 = there was nothing to wait for.",
    arguments: [
      {
        name: "[ops...]",
        description: `Op kinds to wait for — any of ${OP_KIND_IDS.join(" | ")}; default: every op running in this checkout but a plain script run`,
      },
    ],
    options: [
      {
        flags: "--max-wait <seconds>",
        description:
          "Give up waiting after this long and exit 70 with a line saying to call again; " +
          "default 480 (8 minutes). The default sits under the 600 s cap an agent's " +
          "foreground tool call has, so the wait always returns a result the caller can " +
          "read instead of being killed mid-wait with nothing to show. `0` waits forever, " +
          "which is for a human at a terminal, never for an agent.",
      },
      {
        flags: "--arm <seconds>",
        description:
          "How long to wait for an op to APPEAR before deciding there is nothing to wait " +
          "for; default 60. Covers the gap between the call that starts an op and this " +
          "one: the op writes its marker a second or two into its own boot.",
      },
    ],
    run: () => import("./run"),
  },
);
