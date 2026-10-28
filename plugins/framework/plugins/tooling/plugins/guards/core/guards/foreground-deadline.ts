import { envNames } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  foregroundDeadline,
  isHandoffOp,
} from "@plugins/framework/plugins/cli/plugins/foreground-handoff/core";
import { defineGuard } from "../define-guard";
import { parseShell } from "../parse-shell";
import type { BashInput } from "../types";
import { longOpsIn } from "./background-ops";

/** The harness's ceiling for a foreground Bash call (ms). */
export const MAX_FOREGROUND_TIMEOUT_MS = 600_000;

/**
 * A foreground call running a hand-off op (`check`, `test`) tells it when the
 * call will be cut off.
 *
 * The op hands itself off before that instant (`cli/foreground-handoff`): it
 * keeps running detached and the call ends with `./equin await <op>` as the
 * way to its verdict, instead of the harness killing it handle-less at the
 * limit. Only this hook knows the limit, so the command gets an `export` in
 * front — `export`, not a `VAR=… cmd` prefix, so every op of a chain shares the
 * one deadline (`./equin check a && ./equin test b`). The timeout is raised to
 * the ceiling first: no shorter limit serves an op, and the deadline is derived
 * from the limit actually in force.
 *
 * A rewrite, never a denial: it changes nothing the command does before the
 * deadline, and after it, it is the difference between a handle and none.
 */
export const foregroundDeadlineGuard = defineGuard<BashInput>({
  name: "foreground-deadline",
  matcher: "Bash",
  check(input) {
    if (input.run_in_background === true) return null;
    const cmd = input.command;
    if (!cmd) return null;
    if (!longOpsIn(parseShell(cmd)).some(isHandoffOp)) return null;
    const deadline = foregroundDeadline(Date.now(), MAX_FOREGROUND_TIMEOUT_MS);
    return {
      rewrite: {
        timeout: MAX_FOREGROUND_TIMEOUT_MS,
        command: `export ${envNames("FOREGROUND_DEADLINE")
          .map((name) => `${name}=${deadline}`)
          .join(" ")}; ${cmd}`,
      },
    };
  },
});
