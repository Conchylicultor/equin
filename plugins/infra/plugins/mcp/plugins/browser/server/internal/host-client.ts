import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { requestDep } from "@plugins/infra/plugins/deps/server";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { isRelease, PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineDaemon,
  type DaemonInstance,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  agentBrowserStatus,
  AgentBrowserHostStatusSchema,
  type AgentBrowserStatus,
} from "../../core";
import { agentBrowserDir } from "../../data-dirs";
import { hostCodeId } from "../../shared/code-id";
import {
  HOST_FILES,
  HOST_ORIGIN,
  HOST_PROTOCOL,
  HostCloseResultSchema,
  HostErrorBodySchema,
  HostToolResultSchema,
  type HostCallBody,
  type HostToolResult,
} from "../../shared/protocol";
import { revertSessionWrites } from "../../shared/revert";

/**
 * The backend's half of the agent browser: find the machine's host, launch it
 * when there is none, replace it when it runs other code, and forward tool
 * calls to it over its socket. Nothing here holds browser state — that lives
 * in the host process (`bin/host.ts`), which is why it survives this backend's
 * restarts.
 */

const PLUGIN_DIR = join(PLUGINS_DIR, "infra/plugins/mcp/plugins/browser");
const HOST_ENTRY = join(PLUGIN_DIR, "bin/host.ts");
/** A launched host must say `ready` within this, or the launch failed. */
const LAUNCH_MS = 30_000;
/** Closing every session (each a context close + a revert) before an upgrade. */
const SHUTDOWN_MS = 60_000;
/** One tool call: a 30 s navigation, a batch of several actions, a screenshot. */
const CALL_MS = 5 * 60_000;

/** Not installed yet is an answer, not a wait: ask for it and say so. */
export class BrowserUnavailableError extends Error {}

export const agentBrowserHostDaemon = defineDaemon({
  name: "mcp-browser.host",
  description:
    "The agent-browser host: one detached process per machine owning the headless Chromium every agent conversation drives (its contexts, tabs, console and network records), so agents' tabs survive backend restarts. Launched on the first browser_* call; exits 5 min after its last session.",
  startedBy: "on-demand",
  // The process is machine-wide; the record is per backend — whichever one
  // launches or finds it on an agent's call.
  where: "every-worktree",
  restart: { kind: "never" },
});

export const agentBrowserStatusWatcher = defineFileWatcher({
  name: "mcp-browser.host-status",
  description:
    "Watches the agent-browser host's status file and pushes the agent-browser status value (sessions, tabs, deadlines) when the host rewrites it.",
  extensions: [".json"],
});

let codeIdMemo: string | null = null;
/** Which host code this checkout would run. */
function ownCodeId(): string {
  return (codeIdMemo ??= hostCodeId(PLUGIN_DIR));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw err;
  }
}

/** The machine's agent browser, read from the host's own status file. */
export function readAgentBrowserStatus(): AgentBrowserStatus {
  let raw: string;
  try {
    raw = readFileSync(agentBrowserDir.file(HOST_FILES.status), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { kind: "unreadable", reason: `not JSON: ${err.message}` };
  }
  const parsed = AgentBrowserHostStatusSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "unreadable", reason: parsed.error.message };
  }
  const host = parsed.data;
  if (host.state === "exited") return { kind: "exited", host };
  return alive(host.pid) ? { kind: "running", host } : { kind: "died", host };
}

export const agentBrowserStatusServed = serveValue(agentBrowserStatus, {
  source: "external",
  changes: "notified",
  loader: () => readAgentBrowserStatus(),
});

// ── Waiting on the status file ────────────────────────────────────────────

type Waiter = {
  until: (s: AgentBrowserStatus) => boolean;
  resolve: (s: AgentBrowserStatus) => void;
};
const waiters = new Set<Waiter>();
let watcher: FileWatcher | null = null;
let instance: DaemonInstance | null = null;

function onStatusChange(): void {
  agentBrowserStatusServed.notify();
  const status = readAgentBrowserStatus();
  // A clean exit closes this backend's record of it as a run that ended well;
  // a host is meant to leave when idle.
  if (status.kind === "exited" && instance !== null) {
    const ended = instance;
    instance = null;
    void runTracked("mcp-browser:drop-exited-host", () => ended.stop());
  }
  for (const w of waiters) {
    if (w.until(status)) {
      waiters.delete(w);
      w.resolve(status);
    }
  }
}

/**
 * Start pushing the status file's changes (every backend serves the value),
 * and list a host already running — one that outlived this backend's previous
 * incarnation — under Background activity.
 */
export async function startStatusWatcher(): Promise<void> {
  if (watcher) return;
  watcher = await agentBrowserStatusWatcher.start({
    // Subscribing to a missing directory fails; it is host-global and tiny.
    dirs: [agentBrowserDir.ensure()],
    onChange: onStatusChange,
  });
  if (readAgentBrowserStatus().kind === "running") followHost();
}

export async function stopStatusWatcher(): Promise<void> {
  const w = watcher;
  watcher = null;
  await w?.stop();
}

/** Resolve on the first status (now, or a later rewrite) `until` accepts. */
async function waitForStatus(
  until: (s: AgentBrowserStatus) => boolean,
  timeoutMs: number,
  what: string,
): Promise<AgentBrowserStatus> {
  await startStatusWatcher();
  const now = readAgentBrowserStatus();
  if (until(now)) return now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiter: Waiter | undefined;
  try {
    return await new Promise<AgentBrowserStatus>((resolve, reject) => {
      waiter = { until, resolve };
      waiters.add(waiter);
      timer = setTimeout(() => {
        const last = readAgentBrowserStatus();
        reject(
          new Error(
            `[agent-browser] ${what} did not happen within ${timeoutMs}ms (status: ${describe(last)})`,
          ),
        );
      }, timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    if (waiter) waiters.delete(waiter);
  }
}

function describe(s: AgentBrowserStatus): string {
  switch (s.kind) {
    case "absent":
      return "no status file";
    case "unreadable":
      return `unreadable: ${s.reason}`;
    case "running":
      return `running, pid ${s.host.pid}`;
    case "exited":
      return `exited (${s.host.exitReason ?? "no reason"})`;
    case "died":
      return `pid ${s.host.pid} died`;
  }
}

// ── Finding, launching, replacing the host ────────────────────────────────

let ensuring: Promise<void> | null = null;

/** A running host this backend may talk to — launched or replaced if need be. */
export function ensureHost(): Promise<void> {
  ensuring ??= ensureOnce().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

async function ensureOnce(): Promise<void> {
  const status = readAgentBrowserStatus();
  if (status.kind === "running") {
    const { host } = status;
    if (host.protocol === HOST_PROTOCOL && host.codeId === ownCodeId()) {
      followHost();
      return;
    }
    // Other code. Main replaces it — main is where merged code lands, so a
    // host that differs from main's is the stale one. Any other backend uses
    // a host that speaks its protocol rather than fight main over it.
    if (!isMain() && host.protocol === HOST_PROTOCOL) {
      followHost();
      return;
    }
    if (!isMain()) {
      throw new Error(
        `The agent browser on this machine speaks protocol ${host.protocol}; this checkout speaks ${HOST_PROTOCOL}. ` +
          "Only main replaces it — rebase onto main, or close its sessions first.",
      );
    }
    await post("/shutdown", { reason: "upgrade" }, SHUTDOWN_MS);
    await waitForStatus(
      (s) => s.kind !== "running" || s.host.pid !== host.pid,
      SHUTDOWN_MS,
      "the old host's exit",
    );
  }
  if (status.kind === "died") await reclaimDeadSessions(status.host.sessions);
  await launchHost();
}

/** Record a host this backend did not start (or started before a restart). */
function followHost(): void {
  if (instance !== null) return;
  instance = agentBrowserHostDaemon.attach({
    instance: "host",
    pidFile: agentBrowserDir.file(HOST_FILES.pid),
  });
}

/**
 * The sessions a host that died still listed: nothing will close them, so
 * revert each one's writes before a new host takes the status file over.
 */
async function reclaimDeadSessions(
  sessions: readonly { conversationId: string; origin: string }[],
): Promise<void> {
  for (const s of sessions)
    await revertSessionWrites(s.origin, s.conversationId);
}

async function launchHost(): Promise<void> {
  if (isRelease()) {
    throw new BrowserUnavailableError(
      "The agent browser runs its host from source, and a compiled release has none to run.",
    );
  }
  // The backend never installs (a ~280 MB download on its event loop): it
  // reads, and asks for the install when the browser is not there yet.
  const installed = await readyNow(chromium);
  if (installed.kind === "failed") {
    throw new BrowserUnavailableError(
      `Chromium could not be installed: ${installed.message}. ` +
        "Retry with `./singularity deps install chromium`.",
    );
  }
  if (installed.kind !== "ready") {
    await requestDep(chromium);
    throw new BrowserUnavailableError(
      "Chromium is not installed yet — its install (~280 MB, once per machine) " +
        "was requested. Retry in a minute, or run `./singularity deps install chromium`.",
    );
  }
  if (instance !== null) {
    const previous = instance;
    instance = null;
    await previous.stop();
  }
  instance = agentBrowserHostDaemon.launchDetached({
    instance: "host",
    argv: [process.execPath, HOST_ENTRY],
    env: process.env,
    pidFile: agentBrowserDir.file(HOST_FILES.pid),
  });
  const codeId = ownCodeId();
  await waitForStatus(
    // Our host, or one a concurrent launcher (another backend) won the lock with.
    (s) =>
      s.kind === "running" &&
      s.host.protocol === HOST_PROTOCOL &&
      (s.host.codeId === codeId || !isMain()),
    LAUNCH_MS,
    "the agent-browser host's launch",
  );
}

// ── Talking to it ─────────────────────────────────────────────────────────

/** A request the socket could not take: no host there (anymore). */
function isUnreachable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "ConnectionRefused" ||
    code === "FailedToOpenSocket"
  );
}

async function post(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  return fetch(`${HOST_ORIGIN}${path}`, {
    unix: agentBrowserDir.file(HOST_FILES.socket),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Run one tool on the host. A tool's own failure throws its message. */
export async function callHostTool(
  call: HostCallBody,
): Promise<HostToolResult> {
  await ensureHost();
  let res: Response;
  try {
    res = await post("/call", call, CALL_MS);
  } catch (err) {
    // The host left between the status read and the call (idle exit, an
    // upgrade by main): find or launch the next one, once.
    if (!isUnreachable(err)) throw err;
    await ensureHost();
    res = await post("/call", call, CALL_MS);
  }
  const body: unknown = await res.json();
  if (res.ok) return HostToolResultSchema.parse(body);
  const error = HostErrorBodySchema.safeParse(body);
  throw new Error(
    error.success
      ? error.data.error
      : `[agent-browser] host answered HTTP ${res.status}: ${JSON.stringify(body)}`,
  );
}

/**
 * Close a conversation's session when one is open — never launching a host to
 * find out. A host that died still listing it gets its writes reverted here.
 */
export async function closeConversationSession(
  conversationId: string,
): Promise<boolean> {
  const status = readAgentBrowserStatus();
  if (status.kind === "died") {
    const held = status.host.sessions.find(
      (s) => s.conversationId === conversationId,
    );
    if (held) await revertSessionWrites(held.origin, conversationId);
    return false;
  }
  if (status.kind !== "running") return false;
  if (!status.host.sessions.some((s) => s.conversationId === conversationId)) {
    return false;
  }
  const res = await post("/close", { conversationId }, SHUTDOWN_MS);
  if (!res.ok) {
    throw new Error(
      `[agent-browser] closing ${conversationId}'s session failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  return HostCloseResultSchema.parse(await res.json()).closed;
}
