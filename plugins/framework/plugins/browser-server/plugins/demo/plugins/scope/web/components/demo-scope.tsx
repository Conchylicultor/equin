// <DemoScope>: a demo's own browser server. The story and every key a demo
// reads come from the scenario's host (a worker running real portable server
// code on PGlite; a `needsMachine` read answers unavailable without reaching
// it). The page-side server below remains for ONE contributor, config_v2's
// `Demo.Resource` (its in-memory user layer and `set-field` write), until the
// config_v2 split moves config into the host — then this page server, the
// `Demo.Resource` slot and the composition with the host go
// (research/2026-10-20-global-demo-stubs-to-worker.md).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  composeBrowserServers,
  createBrowserServer,
  portBrowserServer,
  type BrowserServe,
  type BrowserServed,
  type BrowserServer,
  type PortServer,
} from "@plugins/framework/plugins/browser-server/core";
import { browserServerTransport } from "@plugins/framework/plugins/browser-server/web";
import {
  DemoMissingError,
  type DemoScenario,
} from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import type { RouteHandler } from "@plugins/framework/plugins/http-router/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { unsupportedEndpointResponse } from "@plugins/infra/plugins/endpoints/core";
import { NotificationsProvider } from "@plugins/primitives/plugins/live-state/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { TransportProvider } from "@plugins/primitives/plugins/networking/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  Demo,
  type DemoBackend,
  type DemoRoute,
} from "@plugins/framework/plugins/browser-server/plugins/demo/web";

// ── Contributed backends, each hook at a stable position ──────────────

interface ContributedBackend {
  /** Who serves it, for the served-twice error. */
  source: string;
  backend: DemoBackend;
}

type ResourceContribution = ReturnType<
  typeof Demo.Resource.useContributions
>[number];

const NO_BACKENDS: readonly ContributedBackend[] = [];

/**
 * Calls every `Demo.Resource` contribution's `useBackend`, one component per
 * contribution (never a `.map` over hooks), threading the collected backends
 * down to `children` — the `CollectFieldExtensions` fold. The contribution
 * list is static per mount, so the recursion depth (and every hook position)
 * is stable.
 */
function CollectBackends({
  resources,
  index,
  acc,
  children,
}: {
  resources: readonly ResourceContribution[];
  index: number;
  acc: readonly ContributedBackend[];
  children: (backends: readonly ContributedBackend[]) => ReactNode;
}): ReactNode {
  const r = resources[index];
  if (r === undefined) return children(acc);
  return (
    <BackendStep
      key={r.id}
      id={r.id}
      useBackend={r.useBackend}
      resources={resources}
      index={index}
      acc={acc}
    >
      {children}
    </BackendStep>
  );
}

function BackendStep({
  id,
  useBackend,
  resources,
  index,
  acc,
  children,
}: {
  id: string;
  useBackend: Hook<() => DemoBackend>;
  resources: readonly ResourceContribution[];
  index: number;
  acc: readonly ContributedBackend[];
  children: (backends: readonly ContributedBackend[]) => ReactNode;
}): ReactNode {
  const backend = useBackend();
  // Stable while every backend is: the server is rebuilt only when one changes.
  const next = useMemo(
    () => [...acc, { source: `Demo.Resource "${id}"`, backend }],
    [acc, id, backend],
  );
  return (
    <CollectBackends resources={resources} index={index + 1} acc={next}>
      {children}
    </CollectBackends>
  );
}

// ── The server ─────────────────────────────────────────────────────────

/**
 * How long one "Not available in the demo" toast stays up: sonner's default
 * duration (`showToast` sets none). While one from this scope is still on
 * screen, further refusals do not toast again.
 */
const TOAST_LIFETIME_MS = 4000;

/** Serve on `s`, claiming each declaration's key for `source` first — so a key served twice names both sources instead of failing inside the runtime. */
function claiming(
  s: BrowserServe,
  source: string,
  owners: Map<string, string>,
  scenarioId: string,
): BrowserServe {
  const claim = (key: string) => {
    const prev = owners.get(key);
    if (prev !== undefined) {
      throw new Error(
        `demo scope "${scenarioId}": "${key}" is served by both ${prev} and ${source}.`,
      );
    }
    owners.set(key, source);
  };
  // Erased: each call is still checked against its declaration by the
  // caller's own `BrowserServe` overloads; this only reads `.key` first.
  type Erased = (decl: { key: string }, opts: unknown) => BrowserServed;
  const value = s.serveValue as unknown as Erased;
  const collection = s.serveCollection as unknown as Erased;
  const claimedValue: Erased = (decl, opts) => {
    claim(decl.key);
    return value(decl, opts);
  };
  const claimedCollection: Erased = (decl, opts) => {
    claim(decl.key);
    return collection(decl, opts);
  };
  return {
    serveValue: claimedValue as unknown as BrowserServe["serveValue"],
    serveCollection:
      claimedCollection as unknown as BrowserServe["serveCollection"],
  };
}

/**
 * Every route the scope answers: each backend's own. A route key claimed twice
 * throws naming both sources.
 */
function scopeRoutes(
  scenarioId: string,
  backends: readonly ContributedBackend[],
): [string, RouteHandler][] {
  const owners = new Map<string, string>();
  const out: [string, RouteHandler][] = [];
  const add = (source: string, [key, handler]: DemoRoute) => {
    const prev = owners.get(key);
    if (prev !== undefined) {
      throw new Error(
        `demo scope "${scenarioId}": route "${key}" is answered by both ${prev} and ${source}.`,
      );
    }
    owners.set(key, source);
    out.push([key, handler]);
  };
  for (const { source, backend } of backends) {
    for (const r of backend.routes ?? []) add(source, r);
  }
  return out;
}

/** The page's server, and the keys the backends serve on it. */
interface PageServer {
  server: BrowserServer;
  keys: ReadonlySet<string>;
}

function buildServer(
  scenario: DemoScenario,
  backends: readonly ContributedBackend[],
  lastToastAt: { current: number | null },
): PageServer {
  const owners = new Map<string, string>();
  const keys = new Set<string>();
  const server = createBrowserServer({
    serve: (s) => {
      const all: BrowserServed[] = [];
      for (const { source, backend } of backends) {
        all.push(...backend.serve(claiming(s, source, owners, scenario.id)));
      }
      // Every key a serve minted (a collection's `:rows`, `:count`… too).
      for (const served of all) for (const key of served.keys) keys.add(key);
      return all;
    },
    routes: scopeRoutes(scenario.id, backends),
    unserved: (key) =>
      new DemoMissingError(
        key,
        "any params — neither the scenario's host nor a Demo.Resource serves this key",
      ),
    onUnmatched: (req, pathname) => {
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        const now = Date.now();
        if (
          lastToastAt.current === null ||
          now - lastToastAt.current >= TOAST_LIFETIME_MS
        ) {
          lastToastAt.current = now;
          showToast({
            title: "Not available in the demo",
            description: `${req.method} ${pathname} is not part of this demo.`,
          });
        }
        return unsupportedEndpointResponse(req.method, pathname);
      }
      return new Response(`Not found in the demo: ${pathname}`, {
        status: 404,
      });
    },
  });
  return { server, keys };
}

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
 * The scope's server once the scenario's host (if any) has booted: the page
 * server alone, or — with a host — the backends' keys first, then every key
 * the worker serves, then the page again (its `unserved` errors). Calls
 * `onReady` with it, or `onFailed` with a host that could not boot; returns the
 * teardown (the server disposed, the worker ended).
 */
function startScopeServer(
  scenario: DemoScenario,
  page: PageServer,
  onReady: (server: BrowserServer) => void,
  onFailed: (err: unknown) => void,
): () => void {
  const host = scenario.host;
  if (host === undefined) {
    onReady(page.server);
    return () => page.server.dispose();
  }
  let ended = false;
  let worker: Worker | null = null;
  let served: BrowserServer = page.server;
  void (async () => {
    const asked = performance.now();
    const { start } = await host();
    if (ended) return;
    worker = start();
    const hosted = await portBrowserServer(worker);
    if (ended) return;
    const line = bootLine(scenario.id, performance.now() - asked, hosted);
    console.info(`[demo-scope] ${line}`);
    clientLog(BOOT_LOG_CHANNEL, line);
    served = composeBrowserServers([page, hosted], page.server);
    onReady(served);
  })().catch((err: unknown) => {
    if (!ended) onFailed(err);
  });
  return () => {
    ended = true;
    served.dispose();
    worker?.terminate();
  };
}

function ScopeServer({
  scenario,
  backends,
  children,
}: {
  scenario: DemoScenario;
  backends: readonly ContributedBackend[];
  children: ReactNode;
}): ReactNode {
  const lastToastAt = useRef<number | null>(null);
  const [server, setServer] = useState<BrowserServer | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    // A throw here (a key served twice, a contributed serve failing) reaches
    // the error boundary like a render error.
    // Built here, not in a useState initialiser: the server is a disposable
    // resource owned by this mount, so StrictMode's mount → unmount → mount
    // disposes the first and keeps the second (an initialiser would build one
    // a discarded render never disposes).
    const page = buildServer(scenario, backends, lastToastAt);
    const stop = startScopeServer(scenario, page, setServer, (error) =>
      setFailure({ error }),
    );
    return () => {
      stop();
      // The next server (a host still booting) is not this one.
      setServer(null);
    };
  }, [scenario, backends]);
  // A host that could not boot reaches the error boundary, never an empty app.
  if (failure !== null) throw failure.error;
  const transport = useMemo(
    () => (server === null ? null : browserServerTransport(server)),
    [server],
  );
  if (transport === null) return <Loading />;
  return (
    <TransportProvider transport={transport}>
      <NotificationsProvider>{children}</NotificationsProvider>
    </TransportProvider>
  );
}

/**
 * Renders `children` against a browser server of its own: the scenario's host
 * (real server code in a worker, on the scenario's seed), and every
 * `Demo.Resource` contribution's backend (its serves and its routes — today
 * config_v2's alone). Any other known live key fails `loader-failed`
 * (`DemoMissingError`); any other `/api` request is refused
 * (`unsupportedEndpointResponse`) with one "Not available in the demo" toast at
 * a time. The host booting renders `<Loading/>`; a host that fails to boot, or
 * a key served (or a route answered) twice, throws to the error boundary.
 */
export function DemoScope({
  scenario,
  children,
}: {
  scenario: DemoScenario;
  children: ReactNode;
}): ReactNode {
  const resources = Demo.Resource.useContributions();
  return (
    <CollectBackends resources={resources} index={0} acc={NO_BACKENDS}>
      {(backends) => (
        <ScopeServer scenario={scenario} backends={backends}>
          {children}
        </ScopeServer>
      )}
    </CollectBackends>
  );
}
