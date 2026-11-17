import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backgroundShellPrefix } from "@plugins/packages/plugins/spawn-priority/core";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";

// The shell prefix an agent's CLI runs every command through
// (`CLAUDE_CODE_SHELL_PREFIX`, packages/spawn-priority's `bin/background-shell`),
// as a COPY in the agent's own `bin/` dir. The script beside this code lives
// in the checkout the backend runs from — on main, a slot
// (infra/git/main-slots) a later build checks out again once nothing holds it,
// while the agent, started detached, keeps running commands for hours. A copy
// is the agent's own and never moves under it; a plain copy is enough for a
// shell script (no signature, no first-exec scan — unlike the claude clone,
// `./named-claude.ts`).
//
// Named by its content (`background-shell-<sha256 prefix>`), so a start finds
// the copy current without comparing, a changed script gets a new name (a
// running CLI keeps the old one), and the copy is written beside the name and
// renamed over it — never seen half-written.

/**
 * The copy of the background-shell script for an agent whose bin dir is
 * `binDir`, made if missing; null where nothing demotes (the escape hatch, a
 * host without taskpolicy).
 */
export async function agentBackgroundShell(
  binDir: string,
): Promise<string | null> {
  const script = backgroundShellPrefix();
  if (script === null) return null;
  const bytes = await readFile(script);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const copy = join(binDir, `background-shell-${hash}`);
  if (await exists(copy)) return copy;
  await mkdir(binDir, { recursive: true });
  const tmp = `${copy}.${String(process.pid)}.tmp`;
  await writeFile(tmp, bytes);
  await chmod(tmp, 0o755);
  await rename(tmp, copy);
  return copy;
}
