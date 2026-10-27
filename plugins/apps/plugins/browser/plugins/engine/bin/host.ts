/**
 * The browser-engine host: ONE detached process per machine owning the
 * Chromium whose pages the Browser app's tabs stream — a persistent profile
 * (logins stick), one page per remote tab key — served over a Unix socket as a
 * WebSocket per viewed tab (`ENGINE_WS_PATH`, the wire in `core/protocol.ts`).
 *
 * A process of its own so tabs outlive the backend: main's backend restarts on
 * every push. A backend launches it on a tab's first attach
 * (`machine/internal/host-client.ts`), finds it again by its status file, and
 * relays each client socket to it byte for byte.
 *
 * Run as `bun bin/host.ts --launched-by <namespace>` from a checkout's source.
 * Exits 30 min after its last page and socket went, on `POST /shutdown`, or on
 * SIGTERM/SIGINT/SIGHUP — closing the browser first, which flushes the profile.
 *
 * Plan: research/2026-10-24-apps-browser-streamed-chromium.md
 */
import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { withForegroundPriority } from "@plugins/packages/plugins/spawn-priority/core";
import { browserDir } from "@plugins/apps/plugins/browser/data-dirs";
import { ENGINE_PROTOCOL, ENGINE_WS_PATH } from "../core";
import { browserEngineDir, browserEngineUploadsDir } from "../data-dirs";
import { hostCodeId } from "../shared/code-id";
import {
  HOST_FILES,
  HostShutdownBodySchema,
  type EngineHostStatus,
} from "../shared/host-files";
import {
  closeAll,
  onClose,
  onDrain,
  onMessage,
  onOpen,
  pagesSnapshot,
  wirePages,
  type SocketData,
} from "./host-pages";

function argValue(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value)
    throw new Error(`[browser-engine] host: ${name} <value> is required`);
  return value;
}

const launchedBy = argValue("--launched-by");
const dir = browserEngineDir.ensure();
const file = (name: string) => browserEngineDir.file(name);
const codeId = hostCodeId(resolve(import.meta.dir, ".."));
const startedAt = new Date().toISOString();

// The singleton: whoever holds the lock is THE host. The kernel drops it when
// this process dies however it dies, so a crashed host never blocks the next.
const lockFd = openSync(file(HOST_FILES.lock), "a");
if (!flockTry(lockFd)) {
  console.error(`[browser-engine] another host holds ${dir}; exiting`);
  process.exit(0);
}

// Out of darwinbg for the host's whole life, before Chromium starts (it
// inherits the tier at spawn): a page the user is looking at and typing into
// is interactive work. Launched by an agent worktree's backend (itself
// darwinbg), the browser otherwise rendered at ~10 fps on the efficiency
// cores — ~200 ms from a click to its frame. The body never settles, so the
// lift is never undone; the process exits instead.
void withForegroundPriority(() => new Promise<never>(() => {}));

// Holding the lock, uploads left behind are a dead host's pages' — gone with them.
rmSync(browserEngineUploadsDir.path, { recursive: true, force: true });
browserEngineUploadsDir.ensure();

// Holding the lock, anything left at the socket path is a dead host's.
const socketPath = file(HOST_FILES.socket);
if (existsSync(socketPath)) unlinkSync(socketPath);

let exiting: string | null = null;

function writeStatus(state: "ready" | "exited"): void {
  const status: EngineHostStatus = {
    protocol: ENGINE_PROTOCOL,
    codeId,
    pid: process.pid,
    launchedBy,
    startedAt,
    state,
    exitReason: state === "exited" ? exiting : null,
    updatedAt: new Date().toISOString(),
    ...pagesSnapshot(),
  };
  const path = file(HOST_FILES.status);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(status, null, 1));
  renameSync(tmp, path);
}

// A burst of changes (a navigation fires several) is one rewrite.
let publishPending: ReturnType<typeof setTimeout> | null = null;
function publish(): void {
  if (publishPending || exiting !== null) return;
  publishPending = setTimeout(() => {
    publishPending = null;
    if (exiting === null) writeStatus("ready");
  }, 250);
}

async function shutdown(reason: string): Promise<void> {
  if (exiting !== null) return;
  exiting = reason;
  if (publishPending) clearTimeout(publishPending);
  try {
    await closeAll();
    await server.stop(true);
  } finally {
    writeStatus("exited");
    unlinkSync(file(HOST_FILES.pid));
    if (existsSync(socketPath)) unlinkSync(socketPath);
    closeSync(lockFd);
    process.exit(0);
  }
}

function exitOn(reason: string): void {
  shutdown(reason).catch((err: unknown) => {
    console.error("[browser-engine] shutdown failed:", err);
    process.exit(1);
  });
}

async function route(
  req: Request,
  srv: Bun.Server<SocketData>,
): Promise<Response | undefined> {
  const { pathname } = new URL(req.url);
  if (pathname === ENGINE_WS_PATH) {
    if (
      srv.upgrade(req, {
        data: { key: null, queue: Promise.resolve(), upload: null },
      })
    ) {
      return undefined;
    }
    return Response.json(
      { error: "WebSocket upgrade expected" },
      { status: 400 },
    );
  }
  if (pathname === "/shutdown" && req.method === "POST") {
    const { reason } = HostShutdownBodySchema.parse(await req.json());
    // Answer first: the caller waits for the exit on the status file.
    setTimeout(() => exitOn(reason), 0);
    return Response.json({ ok: true });
  }
  return Response.json({ error: `No route ${pathname}` }, { status: 404 });
}

const server = Bun.serve<SocketData>({
  unix: socketPath,
  idleTimeout: 0,
  fetch: route,
  websocket: {
    // A static page sends nothing for hours: pings keep a live socket open
    // past the idle timeout and find a dead one.
    sendPings: true,
    // Frames are dropped above a much lower mark (host-pages' MAX_BUFFERED);
    // this is only the hard ceiling.
    backpressureLimit: 8 * 1024 * 1024,
    open: onOpen,
    message: onMessage,
    close: onClose,
    drain: onDrain,
  },
  error(err) {
    console.error("[browser-engine] request failed:", err);
    return Response.json({ error: err.message }, { status: 500 });
  },
});

writeFileSync(file(HOST_FILES.pid), `${process.pid}\n`);
wirePages({
  onChange: publish,
  onIdle: () => exitOn("idle"),
  profileDir: browserDir.subdir("profile").ensure(),
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => exitOn(`signal ${signal}`));
}
// Last: a `ready` status is the backend's signal that the socket answers.
writeStatus("ready");
