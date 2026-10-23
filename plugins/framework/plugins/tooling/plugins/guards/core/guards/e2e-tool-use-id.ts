import { TOOL_USE_ID_ENV, TOOL_USE_ID_RE } from "../tool-use-id";
import { defineGuard } from "../define-guard";
import { parseShell } from "../parse-shell";
import type { BashInput } from "../types";
import { CLI_NAME } from "@plugins/framework/plugins/cli/core";

/**
 * A Bash call that runs an e2e script tells the script which tool call it is.
 *
 * Every e2e run is recorded (`debug/browser-recordings`), and the conversation view
 * shows a recording under the Bash call that launched it. The tool-use id is
 * the only key both sides hold, and only this hook sees it: Claude Code hands
 * no per-call identity to the command itself. So the command gets an `export`
 * in front — `export`, not a `VAR=… cmd` prefix, so it reaches every command of
 * a chain (`./equin build && ./equin run …/e2e/x.ts`).
 *
 * A rewrite, never a denial, and it changes nothing the command does: the
 * variable files the recording, it never chooses the deploy.
 */
export const e2eToolUseIdGuard = defineGuard<BashInput>({
  name: "e2e-tool-use-id",
  matcher: "Bash",
  check(input, ctx) {
    const cmd = input.command;
    if (!cmd || ctx.toolUseId === null) return null;
    if (!TOOL_USE_ID_RE.test(ctx.toolUseId)) return null;
    const runsE2e = parseShell(cmd).calls.some(
      (c) =>
        c.name === CLI_NAME &&
        c.args[0] === "run" &&
        c.args.some((a) => a.includes("/e2e/")),
    );
    if (!runsE2e) return null;
    return {
      rewrite: {
        command: `export ${TOOL_USE_ID_ENV}=${ctx.toolUseId}; ${cmd}`,
      },
    };
  },
});
