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
import {
  isMain,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineDaemon,
  type DaemonInstance,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { ENGINE_PROTOCOL } from "../../core";
import { browserEngineDir } from "../../data-dirs";
import { hostCodeId } from "../../shared/code-id";
import {
  EngineHostStatusSchema,
  HOST_FILES,
  HOST_ORIGIN,
  type EngineHostStatus,
  type EngineStatus,
} from "../../shared/host-files";

/**
 * The backend's half of the browser engine: find the machine's host, launch
 * it when there is none, replace it when this backend may and it runs other
 * code. Nothing here holds browser state — that lives in the host process
 * (`bin/host.ts`), which is why tabs survive this backend's restarts.
 */

const PLUGIN_DIR = join(PLUGINS_DIR, "apps/plugins/browser/plugins/engine");
const HOST_ENTRY = join(PLUGIN_DIR, "bin/host.ts");
/** A launched host must say `ready` within this, or the launch failed. */
const LAUNCH_MS = 30_000;
/** Closing the browser (flushing the profile) before an upgrade. */
const SHUTDOWN_MS = 30_000;

/** Not installed yet (or not runnable here) is an answer, not a wait. */
export class EngineUnavailableError extends Error {}

export const engineHostDaemon = defineDaemon({
  name: "browser-engine.host",
  description:
    "The Browser app's engine host: one detached process per machine owning the Chromium (persistent profile) whose pages the app's tabs stream, so tabs survive backend restarts. Launched when a tab first attaches; exits 30 min after its last page and socket.",
  startedBy: "on-demand",
  // The process is machine-wide; the record is per backend — whichever one
  // launches or finds it.
  where: "every-worktree",
  restart: { kind: "never" },
});

export const engineStatusWatcher = defineFileWatcher({
  name: "browser-engine.host-status",
  description:
    "Watches the browser-engine host's status file, so a backend waiting for the host's launch or exit hears it the moment the host rewrites it.",
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

/** The machine's engine host, read from its own status file. */
export function readEngineStatus(): EngineStatus {
  let raw: string;
  try {
    raw = readFileSync(browserEngineDir.file(HOST_FILES.status), "utf-8");
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
  const parsed = EngineHostStatusSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "unreadable", reason: parsed.error.message };
  }
  const host = parsed.data;
  if (host.state === "exited") return { kind: "exited", host };
  return alive(host.pid) ? { kind: "running", host } : { kind: "died", host };
}

/** The host's Unix socket path. */
export function engineSocketPath(): string {
  return browserEngineDir.file(HOST_FILES.socket);
}

// ── Waiting on the status file ────────────────────────────────────────────

type Waiter = {
  until: (s: EngineStatus) => boolean;
  resolve: (s: EngineStatus) => void;
};
const waiters = new Set<Waiter>();
let watcher: FileWatcher | null = null;
let instance: DaemonInstance | null = null;

function onStatusChange(): void {
  const status = readEngineStatus();
  // A clean exit closes this backend's record of it as a run that ended well;
  // a host is meant to leave when idle.
  if (status.kind === "exited" && instance !== null) {
    const ended = instance;
    instance = null;
    void runTracked("browser-engine:drop-exited-host", () => ended.stop());
  }
  for (const w of waiters) {
    if (w.until(status)) {
      waiters.delete(w);
      w.resolve(status);
    }
  }
}

async function startStatusWatcher(): Promise<void> {
  if (watcher) return;
  watcher = await engineStatusWatcher.start({
    // Subscribing to a missing directory fails; it is host-global and tiny.
    dirs: [browserEngineDir.ensure()],
    onChange: onStatusChange,
  });
}

export async function stopStatusWatcher(): Promise<void> {
  const w = watcher;
  watcher = null;
  await w?.stop();
}

/** Resolve on the first status (now, or a later rewrite) `until` accepts. */
async function waitForStatus(
  until: (s: EngineStatus) => boolean,
  timeoutMs: number,
  what: string,
): Promise<EngineStatus> {
  await startStatusWatcher();
  const now = readEngineStatus();
  if (until(now)) return now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiter: Waiter | undefined;
  try {
    return await new Promise<EngineStatus>((resolve, reject) => {
      waiter = { until, resolve };
      waiters.add(waiter);
      timer = setTimeout(() => {
        reject(
          new Error(
            `[browser-engine] ${what} did not happen within ${timeoutMs}ms (status: ${describe(readEngineStatus())})`,
          ),
        );
      }, timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    if (waiter) waiters.delete(waiter);
  }
}

function describe(s: EngineStatus): string {
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

/**
 * May this backend replace `host`? Main may (merged code is where hosts
 * converge); so may the namespace that launched it — a worktree iterating on
 * the engine replaces its own host on each build, never main's.
 */
function mayReplace(host: EngineHostStatus): boolean {
  return isMain() || host.launchedBy === runtimeNamespace();
}

let ensuring: Promise<void> | null = null;

/** A running host this backend may talk to — launched or replaced if need be. */
export function ensureHost(): Promise<void> {
  ensuring ??= ensureOnce().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

async function ensureOnce(): Promise<void> {
  const status = readEngineStatus();
  if (status.kind === "running") {
    const { host } = status;
    const current =
      host.protocol === ENGINE_PROTOCOL && host.codeId === ownCodeId();
    if (current || (!mayReplace(host) && host.protocol === ENGINE_PROTOCOL)) {
      followHost();
      return;
    }
    if (!mayReplace(host)) {
      throw new EngineUnavailableError(
        `The browser engine on this machine speaks protocol ${host.protocol}; this checkout speaks ${ENGINE_PROTOCOL}. ` +
          `Only main or its launcher (${host.launchedBy}) replaces it — rebase onto main.`,
      );
    }
    await shutdownHost("upgrade");
    await waitForStatus(
      (s) => s.kind !== "running" || s.host.pid !== host.pid,
      SHUTDOWN_MS,
      "the old host's exit",
    );
  }
  await launchHost();
}

/** Record a host this backend did not start (or started before a restart). */
function followHost(): void {
  if (instance !== null) return;
  instance = engineHostDaemon.attach({
    instance: "host",
    pidFile: browserEngineDir.file(HOST_FILES.pid),
  });
}

async function shutdownHost(reason: string): Promise<void> {
  const res = await fetch(`${HOST_ORIGIN}/shutdown`, {
    unix: engineSocketPath(),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(SHUTDOWN_MS),
  });
  if (!res.ok) {
    throw new Error(
      `[browser-engine] /shutdown answered HTTP ${res.status}: ${await res.text()}`,
    );
  }
}

async function launchHost(): Promise<void> {
  if (isRelease()) {
    throw new EngineUnavailableError(
      "The browser engine runs its host from source, and a compiled release has none to run.",
    );
  }
  // The backend never installs (a ~280 MB download on its event loop): it
  // reads, and asks for the install when the browser is not there yet.
  const installed = await readyNow(chromium);
  if (installed.kind === "failed") {
    throw new EngineUnavailableError(
      `Chromium could not be installed: ${installed.message}. ` +
        "Retry with `./equin deps install chromium`.",
    );
  }
  if (installed.kind !== "ready") {
    await requestDep(chromium);
    throw new EngineUnavailableError(
      "Chromium is being installed (~280 MB, once per machine) — the page opens once it is there. " +
        "Or run `./equin deps install chromium`.",
    );
  }
  if (instance !== null) {
    const previous = instance;
    instance = null;
    await previous.stop();
  }
  instance = engineHostDaemon.launchDetached({
    instance: "host",
    argv: [process.execPath, HOST_ENTRY, "--launched-by", runtimeNamespace()],
    env: process.env,
    pidFile: browserEngineDir.file(HOST_FILES.pid),
  });
  const codeId = ownCodeId();
  await waitForStatus(
    // Our host, or one a concurrent launcher (another backend) won the lock with.
    (s) =>
      s.kind === "running" &&
      s.host.protocol === ENGINE_PROTOCOL &&
      (s.host.codeId === codeId || !isMain()),
    LAUNCH_MS,
    "the browser-engine host's launch",
  );
}
