import { join } from "node:path";
import { socketsDir } from "@plugins/infra/plugins/launcher/data-dirs";
import { AGENT_EVENTS_FILE, AGENT_OPTIONS_FILE } from "../../core";
import { sdkAgentsDir } from "../../data-dirs";

// Where one agent's pieces live. Its directory (events + launch options) is
// under `state/sdk-agents/<id>/`; its command socket is NOT beside them — a
// kqueue watch of that directory opens every entry, and open(2) on a socket
// fails — but in the sockets dir, `agents/<id>.sock` (well under macOS's
// 104-byte socket path limit with conversation ids).

/** The agent script beside THIS code — the checkout serving its backend. */
export const AGENT_SCRIPT = join(import.meta.dir, "../../bin/agent.ts");

export function agentDir(conversationId: string): string {
  return sdkAgentsDir.subdir(conversationId).path;
}

export function agentEventsPath(conversationId: string): string {
  return join(agentDir(conversationId), AGENT_EVENTS_FILE);
}

export function agentOptionsPath(conversationId: string): string {
  return join(agentDir(conversationId), AGENT_OPTIONS_FILE);
}

export function agentSocketPath(conversationId: string): string {
  return socketsDir.subdir("agents").file(`${conversationId}.sock`);
}

/** The agent process's stderr, appended across restarts. */
export function agentStderrPath(conversationId: string): string {
  return join(agentDir(conversationId), "stderr.log");
}
