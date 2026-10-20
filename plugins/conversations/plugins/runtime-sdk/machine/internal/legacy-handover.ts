import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { liveSdkConversationIds } from "../../server/internal/rows";
import { legacyAgentDir, legacyAgentSocketsDir } from "./paths";
import { recordReport } from "@plugins/reports/server";
import {
  AgentCommandError,
  AgentNotRunningError,
  shutdownAgentAt,
} from "./socket-client";

// One-time handover (delete once main has run it, 2026-10-20 onwards): agents
// started before agent paths were per namespace listen on `agents/<id>.sock`
// and write `state/sdk-agents/<id>/`, which this code never looks at. Main asks
// each of ITS live conversations' agents to exit; the conversation then reads
// as not running, hibernates (its status unchanged) and resumes from its
// transcript on the next Send — a turn in progress at deploy time stops. Only
// main: a worktree's DB holds copies of main's conversations, so a worktree
// doing this would shut down main's agents.

export async function handOverLegacyAgents(): Promise<void> {
  if (!isMain()) return;
  for (const id of await liveSdkConversationIds()) {
    const socket = join(legacyAgentSocketsDir(), `${id}.sock`);
    if (!existsSync(socket)) continue;
    try {
      await shutdownAgentAt(id, socket);
    } catch (err) {
      // A socket nobody listens on: the agent is already gone.
      if (err instanceof AgentCommandError) {
        // An agent too old to take the command: left running, said so.
        await recordReport({
          kind: "crash",
          source: "server-caught",
          message: `SDK agent ${id} on the pre-namespace socket refused shutdown (${err.message}); it is still running and no backend commands it — kill it by hand`,
          data: {
            errorType: "SdkLegacyHandover",
            label: "runtime-sdk.handover",
          },
        });
        continue;
      }
      if (!(err instanceof AgentNotRunningError)) throw err;
    }
    rmSync(socket, { force: true });
    rmSync(legacyAgentDir(id), { recursive: true, force: true });
  }
}
