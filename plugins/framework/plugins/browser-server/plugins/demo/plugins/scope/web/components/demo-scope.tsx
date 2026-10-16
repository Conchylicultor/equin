import {
  Suspense,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createBrowserServer,
  type BrowserServe,
  type BrowserServed,
  type BrowserServer,
} from "@plugins/framework/plugins/browser-server/core";
import { browserServerTransport } from "@plugins/framework/plugins/browser-server/web";
import {
  DemoMissingError,
  servePack,
  type DemoScenario,
} from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import type { RouteHandler } from "@plugins/framework/plugins/http-router/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { unsupportedEndpointResponse } from "@plugins/infra/plugins/endpoints/core";
import { NotificationsProvider } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { TransportProvider } from "@plugins/primitives/plugins/networking/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  Demo,
  type DemoBackend,
  type DemoRoute,
  type DemoServe,
} from "@plugins/framework/plugins/browser-server/plugins/demo/web";

// ── The pack, loaded once per scenario ─────────────────────────────────

// `use()` needs the SAME promise on every render, so the load is cached by
// the scenario object (a module constant). A failed import or a pack that does
// not parse (`DemoPackError`) rejects it, and `use()` throws that into the
// error boundary — never an empty app.
const loadedPacks = new WeakMap<DemoScenario, Promise<DemoServe>>();

function loadPack(scenario: DemoScenario): Promise<DemoServe> {
  let pending = loadedPacks.get(scenario);
  if (pending === undefined) {
    pending = scenario.pack().then((m) => servePack(m.default));
    loadedPacks.set(scenario, pending);
  }
  return pending;
}

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
 * Every route the scope answers: the stateless `Demo.Route` handlers plus each
 * backend's own. A route key claimed twice throws naming both sources.
 */
function scopeRoutes(
  scenarioId: string,
  routeContributions: readonly DemoRoute[],
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
  for (const r of routeContributions) add("a Demo.Route", r);
  for (const { source, backend } of backends) {
    for (const r of backend.routes ?? []) add(source, r);
  }
  return out;
}

function buildServer(
  scenario: DemoScenario,
  packServe: DemoServe,
  backends: readonly ContributedBackend[],
  routes: readonly DemoRoute[],
  lastToastAt: { current: number | null },
): BrowserServer {
  return createBrowserServer({
    serve: (s) => {
      const owners = new Map<string, string>();
      const all: BrowserServed[] = [];
      for (const { source, serve } of [
        { source: `the pack of "${scenario.id}"`, serve: packServe },
        ...backends.map((b) => ({ source: b.source, serve: b.backend.serve })),
      ]) {
        all.push(...serve(claiming(s, source, owners, scenario.id)));
      }
      return all;
    },
    routes: scopeRoutes(scenario.id, routes, backends),
    unserved: (key) =>
      new DemoMissingError(
        key,
        "any params — neither the pack nor a Demo.Resource serves this key",
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
}

function ScopeServer({
  scenario,
  backends,
  routes,
  children,
}: {
  scenario: DemoScenario;
  backends: readonly ContributedBackend[];
  routes: readonly DemoRoute[];
  children: ReactNode;
}): ReactNode {
  const packServe = use(loadPack(scenario));
  const lastToastAt = useRef<number | null>(null);
  const [server, setServer] = useState<BrowserServer | null>(null);
  useEffect(() => {
    // A throw here (a key served twice, a contributed serve failing) reaches
    // the error boundary like a render error.
    // Built here, not in a useState initialiser: the server is a disposable
    // resource owned by this mount, so StrictMode's mount → unmount → mount
    // disposes the first and keeps the second (an initialiser would build one
    // a discarded render never disposes).
    const built = buildServer(
      scenario,
      packServe,
      backends,
      routes,
      lastToastAt,
    );
    setServer(built);
    return () => built.dispose();
  }, [scenario, packServe, backends, routes]);
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
 * Renders `children` against a browser server of its own, built once the
 * scenario's pack has loaded: the pack's recorded answers, every
 * `Demo.Resource` contribution's backend (its serves and its routes) and every
 * `Demo.Route` handler. Any
 * other known live key fails `loader-failed` (`DemoMissingError`); any other
 * `/api` request is refused (`unsupportedEndpointResponse`) with one
 * "Not available in the demo" toast at a time. The pack loading renders
 * `<Loading/>`; a pack that fails to load or parse, or a key served (or a
 * route answered) twice, throws to the error boundary.
 */
export function DemoScope({
  scenario,
  children,
}: {
  scenario: DemoScenario;
  children: ReactNode;
}): ReactNode {
  const resources = Demo.Resource.useContributions();
  const routeContributions = Demo.Route.useContributions();
  const routes = useMemo(
    () => routeContributions.map((c) => c.route),
    [routeContributions],
  );
  return (
    <CollectBackends resources={resources} index={0} acc={NO_BACKENDS}>
      {(backends) => (
        <Suspense fallback={<Loading />}>
          <ScopeServer scenario={scenario} backends={backends} routes={routes}>
            {children}
          </ScopeServer>
        </Suspense>
      )}
    </CollectBackends>
  );
}
