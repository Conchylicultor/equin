import { defineGuard } from "../define-guard";
import { parseShell, type ShellCall } from "../parse-shell";
import type { BashInput } from "../types";

/**
 * Commands that raise a macOS privacy (TCC) prompt on the user's screen —
 * Automation, Accessibility, Screen Recording — as command prefixes: the name,
 * then any leading args that must follow it (`shortcuts run`; `shortcuts list`
 * is harmless). Nothing in the repo needs any of them.
 *
 * Spelled as Claude Code permission-rule prefixes on purpose: the guard matches
 * them here, and a session that never runs the guard (a scratch profile, which
 * loads no repo `.claude/settings.json`) denies the same list as
 * `Bash(<prefix>:*)` rules.
 */
export const MACOS_TCC_COMMANDS: readonly string[] = [
  "osascript",
  "screencapture",
  "automator",
  "cliclick",
  "peekaboo",
  "shortcuts run",
];

const PREFIXES = MACOS_TCC_COMMANDS.map((p) => p.split(" "));

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** A shell flag cluster holding `-c` (`-c`, `-lc`, `-ec`, …). */
const SCRIPT_FLAG = /^-[a-z]*c[a-z]*$/;
/** `bash -c "bash -c '…'"` nests; past this it is not an accident. */
const MAX_DEPTH = 3;

function matches(call: ShellCall): string | undefined {
  const prefix = PREFIXES.find(
    ([name, ...lead]) =>
      call.name === name && lead.every((arg, i) => call.args[i] === arg),
  );
  return prefix?.join(" ");
}

/**
 * The script a call hands another shell to run: `bash -c "<str>"` or
 * `eval <args…>`. `parseShell` deliberately leaves these strings opaque (it is
 * shared by every Bash guard), so this guard re-parses them itself.
 */
function innerScript(call: ShellCall): string | undefined {
  if (call.name === "eval") return call.args.join(" ");
  if (!SHELLS.has(call.name)) return undefined;
  const flag = call.args.findIndex((a) => SCRIPT_FLAG.test(a));
  return flag === -1 ? undefined : call.args[flag + 1];
}

function findAutomation(cmd: string, depth = 0): string | undefined {
  for (const call of parseShell(cmd).calls) {
    const hit = matches(call);
    if (hit) return hit;
    const inner = depth < MAX_DEPTH ? innerScript(call) : undefined;
    const nested =
      inner === undefined ? undefined : findAutomation(inner, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export const macosAutomationGuard = defineGuard<BashInput>({
  name: "macos-automation",
  matcher: "Bash",
  bypassToken: ".allow-macos-automation",
  check(input) {
    const cmd = input.command;
    if (!cmd) return null;
    const blocked = findAutomation(cmd);
    if (!blocked) return null;
    return {
      blocked: `macOS automation command blocked: ${blocked}.`,
      why: `It raises a macOS permission prompt (Automation, Accessibility or Screen Recording) on the user's screen, and nothing in the repo needs it. Blocked: ${MACOS_TCC_COMMANDS.join(", ")}.`,
      hint: "To check whether an app is running, use `pgrep -x <name>`, `lsappinfo list` or `ps`. For screenshots, use the e2e harness (`screenshot.ts`) or the `browser_screenshot` MCP tool. `open <url|app>` is fine.",
    };
  },
});
