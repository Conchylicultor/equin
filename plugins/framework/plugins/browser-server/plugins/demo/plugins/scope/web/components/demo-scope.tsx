// <DemoScope>: a demo's own browser server — the scenario's host, a worker
// running the real portable server code of the host's composition on PGlite.
// Every read and request inside the scope reaches it: a key it does not serve
// fails `loader-failed` naming the key (a browser host's key set is closed), a
// `needsMachine` read answers unavailable without reaching it, an endpoint it
// does not implement is refused unsupported — and that refusal, and only that
// one, toasts "Not available in the demo".

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  portBrowserServer,
  type BrowserServer,
  type PortServer,
} from "@plugins/framework/plugins/browser-server/core";
import { browserServerTransport } from "@plugins/framework/plugins/browser-server/web";
import type { DemoScenario } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import { isUnsupportedEndpointResponse } from "@plugins/infra/plugins/endpoints/core";
import { NotificationsProvider } from "@plugins/primitives/plugins/live-state/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { TransportProvider } from "@plugins/primitives/plugins/networking/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { PluginScope } from "@plugins/framework/plugins/web-sdk/core";

// ── The refusal toast ──────────────────────────────────────────────────

/**
 * How long one "Not available in the demo" toast stays up: sonner's default
 * duration (`showToast` sets none). While one from this scope is still on
 * screen, further refusals do not toast again.
 */
const TOAST_LIFETIME_MS = 4000;

/** Toast one refused request, at most one toast per lifetime per scope. */
function refusalToast(lastToastAt: {
  current: number | null;
}): (method: string, pathname: string) => void {
  return (method, pathname) => {
    const now = Date.now();
    if (
      lastToastAt.current !== null &&
      now - lastToastAt.current < TOAST_LIFETIME_MS
    ) {
      return;
    }
    lastToastAt.current = now;
    showToast({
      title: "Not available in the demo",
      description: `${method} ${pathname} is not part of this demo.`,
    });
  };
}

/**
 * `server`, toasting each request it refuses as unsupported (its real 409,
 * `isUnsupportedEndpointResponse`) — never one it answers. The response is
 * passed through unchanged, so the caller still sees `EndpointUnsupportedError`.
 */
function toastingRefusals(
  server: BrowserServer,
  toast: (method: string, pathname: string) => void,
): BrowserServer {
  return {
    id: server.id,
    async request(req) {
      const { method, url } = req;
      const res = await server.request(req);
      if (await isUnsupportedEndpointResponse(res)) {
        toast(method, new URL(url).pathname);
      }
      return res;
    },
    connect: (peer) => server.connect(peer),
    dispose: () => server.dispose(),
  };
}

// ── The host ───────────────────────────────────────────────────────────

/** The persisted log every host boot writes one line to (`logs/<this>.jsonl`). */
const BOOT_LOG_CHANNEL = "demo-host-boot";

/**
 * One host boot as a line: the wait the page saw (from asking for the host
 * module to the worker's `ready`), then the worker's own account of it.
 */
function bootLine(
  scenarioId: string,
  waitedMs: number,
  hosted: PortServer,
): string {
  const { boot, readyAtMs } = hosted;
  const stages = boot.stages.map((s) => `${s.name} ${s.ms} ms`).join(", ");
  const slowest = boot.slowest.map((s) => `${s.label} ${s.ms} ms`).join(", ");
  return (
    `${scenarioId}: host ready in ${Math.round(waitedMs)} ms ` +
    `(worker ready at ${readyAtMs} ms: ${stages}; ${boot.plugins} plugins) — slowest: ${slowest}`
  );
}

/**
 * Boot the scenario's host and call `onReady` with its server (refusals
 * toasting), or `onFailed` with a host that could not boot; returns the
 * teardown (the server disposed, the worker ended).
 */
function startScopeServer(
  scenario: DemoScenario,
  lastToastAt: { current: number | null },
  onReady: (server: BrowserServer) => void,
  onFailed: (err: unknown) => void,
): () => void {
  let ended = false;
  let worker: Worker | null = null;
  let served: BrowserServer | null = null;
  void (async () => {
    const asked = performance.now();
    const { start } = await scenario.host.start();
    if (ended) return;
    worker = start();
    const hosted = await portBrowserServer(worker);
    if (ended) return;
    const line = bootLine(scenario.id, performance.now() - asked, hosted);
    console.info(`[demo-scope] ${line}`);
    clientLog(BOOT_LOG_CHANNEL, line);
    served = toastingRefusals(hosted.server, refusalToast(lastToastAt));
    onReady(served);
  })().catch((err: unknown) => {
    if (!ended) onFailed(err);
  });
  return () => {
    ended = true;
    served?.dispose();
    worker?.terminate();
  };
}

/**
 * Renders `children` against the scenario's browser host — real server code
 * in a worker, on the scenario's seed — and scoped to the host's composition
 * (`<PluginScope>`: only the plugins the worker boots contribute inside), so
 * the page shows exactly what the worker serves. A key the host does not serve
 * fails `loader-failed` naming it; an `/api` request it refuses as unsupported
 * shows one "Not available in the demo" toast at a time. The host booting
 * renders `<Loading/>`; a host that fails to boot throws to the error boundary.
 */
export function DemoScope({
  scenario,
  children,
}: {
  scenario: DemoScenario;
  children: ReactNode;
}): ReactNode {
  const lastToastAt = useRef<number | null>(null);
  const [server, setServer] = useState<BrowserServer | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    // Started here, not in a useState initialiser: the host is a disposable
    // resource owned by this mount, so StrictMode's mount → unmount → mount
    // ends the first and keeps the second (an initialiser would start one a
    // discarded render never ends).
    const stop = startScopeServer(scenario, lastToastAt, setServer, (error) =>
      setFailure({ error }),
    );
    return () => {
      stop();
      // The next server (a host still booting) is not this one.
      setServer(null);
    };
  }, [scenario]);
  // A host that could not boot reaches the error boundary, never an empty app.
  if (failure !== null) throw failure.error;
  const transport = useMemo(
    () => (server === null ? null : browserServerTransport(server)),
    [server],
  );
  if (transport === null) return <Loading />;
  return (
    <TransportProvider transport={transport}>
      <NotificationsProvider>
        <PluginScope composition={scenario.host}>{children}</PluginScope>
      </NotificationsProvider>
    </TransportProvider>
  );
}
