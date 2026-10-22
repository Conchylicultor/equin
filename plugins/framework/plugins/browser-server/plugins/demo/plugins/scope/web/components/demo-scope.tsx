// <DemoScope>: a demo's own browser server — the scenario's host, a worker
// running the real portable server code of the host's composition on PGlite.
// Every read and request inside the scope reaches it, and nothing else: a
// `needsMachine` read or endpoint answers unavailable without reaching it, and
// everything else the scoped page reads, calls or registers is served by the
// host — the build's coverage guard (codegen's `browser-host-coverage.ts`)
// holds the host's graph to it. A key or endpoint it still does not serve is a
// gap the guard missed, and fails loudly (`loader-failed` naming the key, an
// `EndpointError` the reports collect), never a toast that hides it.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  portBrowserServer,
  type BrowserServer,
  type PortServer,
} from "@plugins/framework/plugins/browser-server/core";
import { browserServerTransport } from "@plugins/framework/plugins/browser-server/web";
import type { DemoScenario } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import { NotificationsProvider } from "@plugins/primitives/plugins/live-state/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  TransportProvider,
  useTransport,
} from "@plugins/primitives/plugins/networking/web";
import { PluginScope } from "@plugins/framework/plugins/web-sdk/core";

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
 * Boot the scenario's host and call `onReady` with its server, or `onFailed`
 * with a host that could not boot; returns the teardown (the server disposed,
 * the worker ended).
 */
function startScopeServer(
  scenario: DemoScenario,
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
    served = hosted.server;
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
 * the page shows exactly what the worker serves. The host booting renders
 * `<Loading/>`; a host that fails to boot throws to the error boundary.
 */
export function DemoScope({
  scenario,
  children,
}: {
  scenario: DemoScenario;
  children: ReactNode;
}): ReactNode {
  // Whether the scope's telemetry is reported — to the page's own server, the
  // enclosing page's setting (D3: a browser server has nowhere of its own to
  // keep it; `false` would drop it at every emission site).
  const { telemetry } = useTransport();
  const [server, setServer] = useState<BrowserServer | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    // Started here, not in a useState initialiser: the host is a disposable
    // resource owned by this mount, so StrictMode's mount → unmount → mount
    // ends the first and keeps the second (an initialiser would start one a
    // discarded render never ends).
    const stop = startScopeServer(scenario, setServer, (error) =>
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
    () =>
      server === null ? null : browserServerTransport(server, { telemetry }),
    [server, telemetry],
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
