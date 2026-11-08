import type { ShellCall } from "./parse-shell";

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** A shell flag cluster holding `-c` (`-c`, `-lc`, `-ec`, …). */
const SCRIPT_FLAG = /^-[a-z]*c[a-z]*$/;

/** `bash -c "bash -c '…'"` nests; past this it is not an accident. */
export const MAX_INNER_DEPTH = 3;

/**
 * The script a call hands another shell to run: `bash -c "<str>"` or
 * `eval <args…>`. `parseShell` deliberately leaves these strings opaque (it is
 * shared by every Bash guard), so a guard that must see inside re-parses them
 * itself — with the call's cwd, which the inner shell starts in.
 */
export function innerScript(call: ShellCall): string | undefined {
  if (call.name === "eval") return call.args.join(" ");
  if (!SHELLS.has(call.name)) return undefined;
  const flag = call.args.findIndex((a) => SCRIPT_FLAG.test(a));
  return flag === -1 ? undefined : call.args[flag + 1];
}
