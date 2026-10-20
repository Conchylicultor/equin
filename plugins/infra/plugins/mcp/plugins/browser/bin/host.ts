/**
 * The agent-browser host: ONE detached process per machine owning the headless
 * Chromium every agent conversation drives — its contexts, tabs and their
 * console / network records — served to backends over a Unix socket.
 *
 * Why a process of its own: Playwright creates every context with
 * `disposeOnDetach`, so whoever holds the Playwright connection owns every
 * tab, and a backend restart (main restarts on every push) used to take them
 * all down mid-investigation. This process outlives any backend. A backend
 * launches it on first use (`server/internal/host-client.ts`, a
 * `defineDaemon` detached launch), finds it again after a restart by its
 * status file, and replaces it only when its own code differs.
 *
 * Run as `bun bin/host.ts` from a checkout's source. Exits 5 min after its last
 * session closes, on `/shutdown`, or on SIGTERM/SIGINT/SIGHUP — closing every
 * session (reverting each one's writes) and Chromium first.
 *
 * Plan: research/2026-10-17-infra-agent-browser-persistent-host.md
 */
import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import type { AgentBrowserHostStatus } from "../core";
import { agentBrowserDir } from "../data-dirs";
import { hostCodeId } from "../shared/code-id";
import {
  HOST_FILES,
  HOST_PROTOCOL,
  HostCallBodySchema,
  HostCloseBodySchema,
  HostShutdownBodySchema,
} from "../shared/protocol";
import { isBrowserToolName } from "../shared/tools";
import {
  closeAll,
  closeSession,
  hostSnapshot,
  recordHostError,
  wireHost,
} from "./host-session";
import { drivesSnapshot, wireDrives } from "./host-drives";
import { runTool } from "./host-tools";
import { sampleUsage } from "./host-usage";

const dir = agentBrowserDir.ensure();
const file = (name: string) => agentBrowserDir.file(name);
const codeId = hostCodeId(resolve(import.meta.dir, ".."));
const startedAt = new Date().toISOString();

// The singleton: whoever holds the lock is THE host. The kernel drops it when
// this process dies however it dies, so a crashed host never blocks the next.
const lockFd = openSync(file(HOST_FILES.lock), "a");
if (!flockTry(lockFd)) {
  console.error(`[agent-browser] another host holds ${dir}; exiting`);
  process.exit(0);
}

// Holding the lock, anything left at the socket path is a dead host's.
const socketPath = file(HOST_FILES.socket);
if (existsSync(socketPath)) unlinkSync(socketPath);

let exiting: string | null = null;

function writeStatus(state: "ready" | "exited"): void {
  const status: AgentBrowserHostStatus = {
    protocol: HOST_PROTOCOL,
    codeId,
    pid: process.pid,
    startedAt,
    state,
    exitReason: state === "exited" ? exiting : null,
    updatedAt: new Date().toISOString(),
    ...hostSnapshot(),
    drives: drivesSnapshot(),
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
  }, 100);
}

async function shutdown(reason: string): Promise<void> {
  if (exiting !== null) return;
  exiting = reason;
  if (publishPending) clearTimeout(publishPending);
  await server.stop(true);
  try {
    await closeAll();
  } finally {
    writeStatus("exited");
    unlinkSync(file(HOST_FILES.pid));
    if (existsSync(socketPath)) unlinkSync(socketPath);
    closeSync(lockFd);
    process.exit(0);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function route(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body: unknown = await req.json();
  switch (pathname) {
    case "/call": {
      const call = HostCallBodySchema.parse(body);
      if (!isBrowserToolName(call.tool)) {
        return json({ error: `Unknown tool "${call.tool}".` }, 404);
      }
      try {
        return json(
          await runTool(call.tool, call.args, {
            conversationId: call.conversationId,
            target: call.target,
          }),
        );
      } catch (err) {
        // The tool's own failure: the agent's to read, not the host's.
        if (!(err instanceof Error)) throw err;
        return json({ error: err.message }, 422);
      }
    }
    case "/close": {
      const { conversationId } = HostCloseBodySchema.parse(body);
      return json({ closed: await closeSession(conversationId) });
    }
    case "/usage":
      return json(await sampleUsage());
    case "/shutdown": {
      const { reason } = HostShutdownBodySchema.parse(body);
      // Answer first: the caller waits for the exit on the status file.
      setTimeout(() => {
        shutdown(reason).catch((err: unknown) => {
          recordHostError("shutdown", err);
          process.exit(1);
        });
      }, 0);
      return json({ ok: true });
    }
    default:
      return json({ error: `No route ${pathname}` }, 404);
  }
}

const server = Bun.serve({
  unix: socketPath,
  // A tool call can legitimately wait on a 30 s navigation, and a batch on
  // several; the backend bounds each call itself.
  idleTimeout: 0,
  fetch: route,
  error(err) {
    recordHostError("request", err);
    return json({ error: err.message }, 500);
  },
});

writeFileSync(file(HOST_FILES.pid), `${process.pid}\n`);
wireDrives(publish);
wireHost({
  onChange: publish,
  onIdle: () => {
    shutdown("idle").catch((err: unknown) => {
      recordHostError("shutdown", err);
      process.exit(1);
    });
  },
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    shutdown(`signal ${signal}`).catch((err: unknown) => {
      recordHostError("shutdown", err);
      process.exit(1);
    });
  });
}
// Last: a `ready` status is the backend's signal that the socket answers.
writeStatus("ready");
