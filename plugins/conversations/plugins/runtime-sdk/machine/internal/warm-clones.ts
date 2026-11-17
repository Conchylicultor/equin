import { basename } from "node:path";
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  pidAlive,
  readPidFile,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { bundledClaudeBin } from "@plugins/infra/plugins/claude-cli/plugins/sdk/machine";
import {
  cloneNamedBinary,
  isCurrentCloneOf,
} from "@plugins/packages/plugins/process-name/machine";
import { backgroundArgv } from "@plugins/packages/plugins/spawn-priority/core";
import { exists } from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { hibernatedSdkConversationIds } from "../../server/internal/rows";
import { readAgentOptions } from "./agent-process";
import { agentBinDir, agentOptionsPath, agentPidPath } from "./paths";

// Waking a hibernated conversation starts its agent, and the agent's claude is
// a clone named for the conversation (`named-claude.ts`). macOS scans an
// executable on its first exec at a path — ~3.3 s for the 322 MB claude, then
// 0.02 s (measured 2026-11-17) — and a Claude Code upgrade makes every kept
// clone outdated, so the first wake after one re-cloned and paid the scan
// inside the request: `resume-hibernated` at 3.4–9.4 s on every wake after a
// version change since 2026-11-11, 0.3–1.1 s on the same version.
//
// So the scan is paid here, in the background, for exactly the conversations a
// click wakes: each hibernated one whose clone is not current is re-cloned
// under its kept name (its macOS grants are keyed by it) and run once with
// `--version`, which the verdict then covers — whoever execs it next (the
// agent, through disclaim-exec) starts at once. Measured: a darwinbg
// `--version` exec pays the full scan; the later disclaim-exec start 0.02 s.
//
// When: at boot (a new Claude Code arrives with a new build, so a boot is when
// clones go stale) and hourly, for an agent running through an upgrade and
// hibernated since. A pass with nothing outdated is a stat per conversation.

const log = Log.channel("runtime-sdk-warm-clones");

/** A `--version` run is milliseconds once scanned; the scan itself ~3 s. */
const WARM_TIMEOUT_MS = 60_000;

export const warmClaudeClonesJob = defineJob({
  name: "runtime-sdk.warm-claude-clones",
  description:
    "Re-clones and runs once (claude --version, at background priority) the conversation-named claude of every hibernated conversation whose clone an upgrade left outdated, so macOS's ~3 s first-exec scan is paid here and not when the user opens the conversation.",
  // seconds: one ~3 s scan per outdated clone, only after a Claude Code upgrade.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "17 * * * *" }, // hourly
  async run() {
    const r = await warmHibernatedClaudeClones();
    if (r.warmed > 0 || r.failed.length > 0)
      log.publish(
        `warmed ${String(r.warmed)} claude clone(s) of ${String(r.checked)} hibernated conversation(s)`,
      );
    if (r.failed.length > 0) {
      throw new Error(
        `Could not warm the claude clone of ${String(r.failed.length)} hibernated conversation(s):\n${r.failed.join("\n")}`,
      );
    }
  },
});

interface WarmPass {
  checked: number;
  warmed: number;
  failed: string[];
}

async function warmHibernatedClaudeClones(): Promise<WarmPass> {
  const out: WarmPass = { checked: 0, warmed: 0, failed: [] };
  const claudeBin = await bundledClaudeBin();
  // One at a time: each scan is syspolicyd's work, and nothing waits on it.
  // One conversation that fails does not keep the others cold; the pass then
  // fails naming every one.
  for (const id of await hibernatedSdkConversationIds()) {
    out.checked++;
    try {
      if (await warmOne(id, claudeBin)) out.warmed++;
    } catch (err) {
      out.failed.push(
        `${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** Re-clone and run once the outdated claude of `id`; false when it needs nothing. */
async function warmOne(id: string, claudeBin: AppPath): Promise<boolean> {
  // A start since the list was read clones and execs it itself.
  if (await agentMayRun(id)) return false;
  // Never started here (a fork's copy of main's row), or started without a
  // name (no disclaim): no clone of its own to warm.
  if (!(await exists(agentOptionsPath(id)))) return false;
  const previous = (await readAgentOptions(id)).namedClaudeBin;
  if (previous === null) return false;
  // The name is kept, never the path: the clone lives in this agent's bin/.
  // Missing counts as outdated — the daily reclaim deletes an outdated one.
  const name = basename(previous);
  if (await isCurrentCloneOf(joinAppPath(agentBinDir(id), name), [claudeBin]))
    return false;
  const named = await cloneNamedBinary({
    bin: claudeBin,
    dir: agentBinDir(id),
    name,
  });
  // Refused (not APFS): the start runs claude itself, and reports it.
  if (named.kind === "refused") return false;
  const run = await spawnCaptured(backgroundArgv([named.path, "--version"]), {
    timeoutMs: WARM_TIMEOUT_MS,
  });
  if (run.exitCode !== 0 || run.timedOut) {
    throw new Error(
      `${named.path} --version ${run.timedOut ? "timed out" : `exited ${String(run.signalCode ?? run.exitCode)}`}: ${run.stderr.trim()}`,
    );
  }
  return true;
}

/** Whether the agent of `id` may be running (its pid file names a live pid). */
async function agentMayRun(id: string): Promise<boolean> {
  const read = await readPidFile(agentPidPath(id));
  if (read.kind === "absent") return false;
  if (read.kind === "unreadable") return true;
  return pidAlive(read.pid);
}
