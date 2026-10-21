import { join } from "node:path";
import { socketsDir } from "@plugins/infra/plugins/launcher/data-dirs";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { AGENT_EVENTS_FILE, AGENT_OPTIONS_FILE } from "../../core";
import { sdkAgentPidsDir, sdkAgentsDir } from "../../data-dirs";

// Where one agent's pieces live — always under the namespace of the backend
// that launched it, read here and never passed in, so a backend can only spell
// its OWN agents. A worktree's DB is a fork of main's and holds copies of
// main's live conversations; with paths keyed by the conversation id alone, the
// worktree's backend found main's agents answering and commanded them.
//
// Its directory (options, events, log) is `state/sdk-agents/<ns>/<id>/`; its
// pid file `locks/sdk-agents/<ns>/<id>.pid`; its command socket is NOT beside
// the events — a kqueue watch of that directory opens every entry, and open(2)
// on a socket fails — but in the sockets dir, `agents/<ns>/<id>.sock`.

/** The agent script beside THIS code — the checkout serving its backend. */
export const AGENT_SCRIPT = join(import.meta.dir, "../../bin/agent.ts");

// macOS's sun_path is 104 bytes, NUL included.
const MAX_SOCKET_PATH_BYTES = 103;

/** This backend's agent directories: `state/sdk-agents/<ns>/`. */
export function ownAgentsRoot(): string {
  return sdkAgentsDir.file(runtimeNamespace());
}

export function agentDir(conversationId: string): string {
  return join(ownAgentsRoot(), conversationId);
}

export function agentEventsPath(conversationId: string): string {
  return join(agentDir(conversationId), AGENT_EVENTS_FILE);
}

export function agentOptionsPath(conversationId: string): string {
  return join(agentDir(conversationId), AGENT_OPTIONS_FILE);
}

/** The agent process's stdout and stderr, appended across restarts. */
export function agentLogPath(conversationId: string): string {
  return join(agentDir(conversationId), "agent.log");
}

/** Every namespace's pid files: `locks/sdk-agents/`. */
export function agentPidsRoot(): string {
  return sdkAgentPidsDir.path;
}

/** This backend's pid files: `locks/sdk-agents/<ns>/`. */
export function ownAgentPidsDir(): string {
  return join(agentPidsRoot(), runtimeNamespace());
}

export function agentPidPath(conversationId: string): string {
  return join(ownAgentPidsDir(), `${conversationId}.pid`);
}

export function agentSocketPath(conversationId: string): string {
  const path = socketsDir.file(
    "agents",
    runtimeNamespace(),
    `${conversationId}.sock`,
  );
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `SDK agent socket path is ${Buffer.byteLength(path)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte Unix socket limit: ${path}`,
    );
  }
  return path;
}
