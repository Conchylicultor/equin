import { defineGuard } from "../define-guard";
import { parseShell, type ShellCall } from "../parse-shell";
import type { BashInput } from "../types";

/**
 * Readers that consume their whole input before exiting: piping into one hides
 * the upstream command's exit code, and nothing upstream can be cut short.
 */
const DRAINERS = new Set(["tail", "tee"]);

const GREPS = new Set(["grep", "egrep", "fgrep", "ggrep", "rg", "ripgrep"]);

/** A `sed` script with a quit command: `5q`, `1,10p;10q`, `/x/Q`. */
const SED_QUIT = /(?:^|[^A-Za-z])[qQ](?:$|[^A-Za-z])/;

/**
 * True when `call` may exit before reading all of its input — which kills the
 * writer upstream with SIGPIPE (exit 141). Under pipefail that turns a command
 * that worked into a reported failure, so any such reader keeps pipefail off.
 *
 * Errs toward "yes" on purpose. Over-matching only leaves a command as it was
 * typed; under-matching reports a false 141. So a `sed` script with a `q`
 * anywhere in it counts, and so does any grep cluster carrying `q`, `l` or `m`.
 */
function stopsReadingEarly(call: ShellCall): boolean {
  if (call.name === "head") return true;
  if (GREPS.has(call.name))
    return call.args.some(
      (a) =>
        /^-[a-zA-Z]*[qlm]/.test(a) ||
        /^--(quiet|silent|max-count|files-with-matches)\b/.test(a),
    );
  if (call.name === "sed")
    return call.args.some((a) => !a.startsWith("-") && SED_QUIT.test(a));
  if (call.name === "awk" || call.name === "gawk")
    return call.args.some((a) => /\bexit\b/.test(a));
  return false;
}

function setsPipefail(call: ShellCall): boolean {
  if (call.name === "set") return call.args.includes("pipefail");
  if (call.name === "setopt")
    return call.args.some((a) => /^(no_?)?pipe_?fail$/i.test(a));
  return false;
}

export const PIPEFAIL_PREFIX = "set -o pipefail; ";

/**
 * `cmd | tail -20` exits with TAIL's status, so a failing `cmd` reports
 * success and the agent reads the last lines of an error as a pass. Prefixing
 * `set -o pipefail` makes the pipeline exit with the last failing stage's
 * status instead.
 *
 * A rewrite, not a denial: the fix is mechanical and changes nothing the agent
 * meant. Scoped to pipelines ending in a reader that drains its input, and
 * dropped whenever any stage of the command may stop reading early — pipefail
 * is command-wide, so one `| head` anywhere would surface its writer's SIGPIPE
 * as a failure.
 */
export const pipefailGuard = defineGuard<BashInput>({
  name: "pipefail",
  matcher: "Bash",
  check(input) {
    const cmd = input.command;
    if (!cmd) return null;
    const { calls } = parseShell(cmd);
    if (!calls.some((c) => c.pipedIn && DRAINERS.has(c.name))) return null;
    if (calls.some((c) => c.pipedIn && stopsReadingEarly(c))) return null;
    // The agent already chose — including choosing `set +o pipefail`.
    if (calls.some(setsPipefail)) return null;
    return { rewrite: { command: PIPEFAIL_PREFIX + cmd }, note: null };
  },
});
