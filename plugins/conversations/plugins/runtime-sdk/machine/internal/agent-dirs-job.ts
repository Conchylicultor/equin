import { z } from "zod";
import {
  Workspace,
  WorkspaceReclaimed,
} from "@plugins/conversations/plugins/workspace/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import {
  isCurrentCloneOf,
  sharedBunsNamed,
} from "@plugins/packages/plugins/process-name/machine";
import { processName } from "@plugins/packages/plugins/process-name/core";
import { bundledClaudeBin } from "@plugins/infra/plugins/claude-cli/plugins/sdk/machine";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { sdkAgentPidsDir, sdkAgentsDir } from "../../data-dirs";
import {
  attemptsOfConversations,
  conversationIdsOfAttempts,
  workspacesOfAttempts,
} from "../../server/internal/rows";
import {
  reclaimAttemptAgentDirs,
  sweepReclaimedAgentDirs,
  type AgentDirFacts,
  type AgentDirRoots,
  type AgentDirsReclaim,
} from "./agent-dirs-reclaim";

const log = Log.channel("runtime-sdk-agent-dirs");

function roots(): AgentDirRoots {
  return {
    agentsRoot: sdkAgentsDir.path,
    pidsRoot: sdkAgentPidsDir.path,
    ownNamespace: runtimeNamespace(),
  };
}

// This backend's DB, and the workspace registry for where each attempt's
// workspace lives — whatever its kind, named by none here.
const facts: AgentDirFacts = {
  attemptsOfConversations,
  conversationsOfAttempts: conversationIdsOfAttempts,
  async workspacePresent(attemptIds) {
    const out = new Map<string, boolean>();
    for (const [id, spec] of await workspacesOfAttempts(attemptIds)) {
      out.set(id, await exists(await Workspace.pathFor(spec.kind, id)));
    }
    return out;
  },
  // What `startAgentProcess` clones into an agent's `bin/`: the Agent SDK's
  // claude (its bun is the shared one below).
  async cloneIsCurrent(path) {
    return isCurrentCloneOf(path, [await bundledClaudeBin()]);
  },
  sharedAgentBuns: () => sharedBunsNamed(processName("agent")),
  // This backend's bun. A worktree backend on another Bun re-clones its own
  // at its agent's next start.
  sharedBunIsCurrent: (path) =>
    isCurrentCloneOf(path, [asAppPath(process.execPath)]),
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function describe(r: AgentDirsReclaim): string {
  return `${String(r.removed)} agent dir(s), ${String(r.namespacesRemoved)} namespace dir(s), ${String(r.staleClonesRemoved)} outdated clone(s) and ${String(r.staleSharedBunsRemoved)} outdated shared agent bun(s); kept ${String(r.live)} running, ${String(r.present)} whose workspace is on disk, ${String(r.unknown)} this database cannot place`;
}

/**
 * A reaper deleted these attempts' workspaces: their agents' directories go
 * with them. Runs in whichever process reaped — the worktree sweep's
 * supervised child, a delete request, the scratch reap job.
 */
export const agentDirsOnReclaim = WorkspaceReclaimed({
  id: "runtime-sdk.agent-dirs",
  async onReclaimed(attemptIds) {
    const r = await reclaimAttemptAgentDirs(attemptIds, roots(), facts);
    log.publish(`reclaimed ${attemptIds.join(", ")}: removed ${describe(r)}`);
  },
});

// The backstop: the announcement's rule for whatever it missed — the agent
// directories of workspaces reaped before it existed, or by a reap whose
// handler failed. A schedule, not a watch: nothing signals that a workspace
// went missing. Main only (the default): it owns the conversation rows, and the
// namespaces of every checkout are machine-wide.
export const agentDirsReclaimJob = defineJob({
  name: "runtime-sdk.agent-dirs-reclaim",
  description:
    "Deletes the state of SDK agents (event log, launch options, log) whose conversation's workspace no longer exists and whose agent is not running, the named claude clones a stopped agent kept that an upgrade has since replaced (and the per-conversation bun clones older starts made), and the shared `equin · agent` bun of a Bun version no running agent uses any more.",
  // seconds: a readdir and a stat per agent directory, one indexed read per batch.
  hold: "seconds",
  input: z.object({ dryRun: z.boolean().default(false) }),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "50 4 * * *" }, // daily at 04:50 UTC
  async run({ input: { dryRun } }) {
    const r = await sweepReclaimedAgentDirs(roots(), facts, { dryRun });
    log.publish(
      `${dryRun ? "dry run: would remove" : "removed"} ${describe(r)}`,
    );
  },
});
