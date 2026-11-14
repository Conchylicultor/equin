import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { parseBypassArgs } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/bypass/core";

/**
 * `./equin guard bypass <id> --reason "…"`: the hook already recorded the
 * bypass when it judged this call (`core/runner.ts`); this re-reads the same
 * grammar so a malformed one fails here too, and states what it allows.
 */
const run: CliAction<[string], { reason?: string }> = async (id, opts) => {
  const parsed = parseBypassArgs([
    "guard",
    "bypass",
    id,
    ...(opts.reason === undefined ? [] : ["--reason", opts.reason]),
  ]);
  if (!parsed.ok) {
    console.error(`guard bypass: ${parsed.why}`);
    process.exitCode = 1;
    return;
  }
  const { guard } = parsed.request;
  console.log(
    `Bypass recorded: the next identical call refused by \`${guard}\` goes through, once. ` +
      "Retry the denied call exactly as it was — a changed call is judged afresh.",
  );
};

export default run;
