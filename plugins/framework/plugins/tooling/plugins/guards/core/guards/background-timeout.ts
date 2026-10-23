import { defineGuard } from "../define-guard";
import { parseShell } from "../parse-shell";
import type { BashInput } from "../types";
import { CLI_NAME } from "@plugins/framework/plugins/cli/core";

/** The harness's ceiling for a background task's lifetime (ms). */
export const MAX_BACKGROUND_TIMEOUT_MS = 7_200_000;

/**
 * A backgrounded `./equin` command gets the longest life the harness
 * allows.
 *
 * `run_in_background` is not untimed: the harness stops a background task after
 * its `timeout`, 30 minutes when the call names none. Build p90 is 36.8 min and
 * push p90 35.7 min (op-log, 14 days — see `background-ops`), and an e2e script
 * can sit 30+ min in the host CPU queue before it starts, so the default kills a
 * real share of ops that were healthy. The kill leaves a build `running` with a
 * dead pid and no verdict.
 *
 * Every subcommand, not only the long ones: nothing about a `./equin`
 * command is made better by being killed at 30 minutes, and a list would have
 * to guess which `run` script is an op. A rewrite, not a denial — the fix is
 * mechanical and changes nothing the agent meant. An explicit timeout the agent
 * typed is raised too: none shorter than the ceiling serves an op.
 */
export const backgroundTimeoutGuard = defineGuard<BashInput>({
  name: "background-timeout",
  matcher: "Bash",
  check(input) {
    if (input.run_in_background !== true) return null;
    const cmd = input.command;
    if (!cmd) return null;
    if (!parseShell(cmd).calls.some((c) => c.name === CLI_NAME)) return null;
    if (input.timeout === MAX_BACKGROUND_TIMEOUT_MS) return null;
    return { rewrite: { timeout: MAX_BACKGROUND_TIMEOUT_MS } };
  },
});
