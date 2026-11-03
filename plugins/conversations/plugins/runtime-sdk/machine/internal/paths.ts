import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { socketsDir } from "@plugins/infra/plugins/launcher/data-dirs";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  AGENT_EVENTS_FILE,
  AGENT_OPTIONS_FILE,
  claudeUsageFileName,
} from "../../core";
import { claudeUsageDir, sdkAgentPidsDir, sdkAgentsDir } from "../../data-dirs";

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
export const AGENT_SCRIPT = asAppPath(
  join(import.meta.dir, "../../bin/agent.ts"),
);

// macOS's sun_path is 104 bytes, NUL included.
const MAX_SOCKET_PATH_BYTES = 103;

/** This backend's agent directories: `state/sdk-agents/<ns>/`. */
export function ownAgentsRoot(): AppPath {
  return sdkAgentsDir.file(runtimeNamespace());
}

export function agentDir(conversationId: string): AppPath {
  return joinAppPath(ownAgentsRoot(), conversationId);
}

export function agentEventsPath(conversationId: string): AppPath {
  return joinAppPath(agentDir(conversationId), AGENT_EVENTS_FILE);
}

/** Whether any generation of the agent's events file (rotated ones included) is on disk. */
export function agentEventsExist(conversationId: string): boolean {
  const path = agentEventsPath(conversationId);
  return [
    path,
    asAppPath(`${path}.1`),
    asAppPath(`${path}.2`),
    asAppPath(`${path}.3`),
  ].some((p) => existsSync(p));
}

export function agentOptionsPath(conversationId: string): AppPath {
  return joinAppPath(agentDir(conversationId), AGENT_OPTIONS_FILE);
}

/**
 * Where the agent's conversation-named clones live: to claude (see
 * `named-claude.ts`) and to the bun the agent runs on (`startAgentProcess`) —
 * `<agent dir>/bin/`, holding at most those two files.
 */
export function agentBinDir(conversationId: string): AppPath {
  return joinAppPath(agentDir(conversationId), "bin");
}

/** The agent process's stdout and stderr, appended across restarts. */
export function agentLogPath(conversationId: string): AppPath {
  return joinAppPath(agentDir(conversationId), "agent.log");
}

/** Every namespace's pid files: `locks/sdk-agents/`. */
export function agentPidsRoot(): AppPath {
  return sdkAgentPidsDir.path;
}

/** This backend's pid files: `locks/sdk-agents/<ns>/`. */
export function ownAgentPidsDir(): AppPath {
  return joinAppPath(agentPidsRoot(), runtimeNamespace());
}

export function agentPidPath(conversationId: string): AppPath {
  return joinAppPath(ownAgentPidsDir(), `${conversationId}.pid`);
}

/**
 * The usage every agent on `accountId`, of every namespace, overwrites — the
 * limits are the Claude account's, so the path is machine-wide on purpose.
 */
export function claudeUsagePath(accountId: string): AppPath {
  return claudeUsageDir.file(claudeUsageFileName(accountId));
}

export function agentSocketPath(conversationId: string): AppPath {
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
