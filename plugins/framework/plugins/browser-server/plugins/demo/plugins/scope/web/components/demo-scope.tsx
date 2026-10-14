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

// ── Contributed serves, each hook at a stable position ────────────────

interface ContributedServe {
  /** Who serves it, for the served-twice error. */
  source: string;
  serve: DemoServe;
}

type ResourceContribution = ReturnType<
  typeof Demo.Resource.useContributions
>[number];

const NO_SERVES: readonly ContributedServe[] = [];

/**
 * Calls every `Demo.Resource` contribution's `useServe`, one component per
 * contribution (never a `.map` over hooks), threading the collected serves
 * down to `children` — the `CollectFieldExtensions` fold. The contribution
 * list is static per mount, so the recursion depth (and every hook position)
 * is stable.
 */
function CollectServes({
  resources,
  index,
  acc,
  children,
}: {
  resources: readonly ResourceContribution[];
  index: number;
  acc: readonly ContributedServe[];
  children: (serves: readonly ContributedServe[]) => ReactNode;
}): ReactNode {
  const r = resources[index];
  if (r === undefined) return children(acc);
  return (
    <ServeStep
      key={r.id}
      id={r.id}
      useServe={r.useServe}
      resources={resources}
      index={index}
      acc={acc}
    >
      {children}
    </ServeStep>
  );
}

function ServeStep({
  id,
  useServe,
  resources,
  index,
  acc,
  children,
}: {
  id: string;
  useServe: Hook<() => DemoServe>;
  resources: readonly ResourceContribution[];
  index: number;
  acc: readonly ContributedServe[];
  children: (serves: readonly ContributedServe[]) => ReactNode;
}): ReactNode {
  const serve = useServe();
  // Stable while every serve is: the server is rebuilt only when one changes.
  const next = useMemo(
    () => [...acc, { source: `Demo.Resource "${id}"`, serve }],
    [acc, id, serve],
  );
  return (
    <CollectServes resources={resources} index={index + 1} acc={next}>
      {children}
    </CollectServes>
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

function buildServer(
  scenario: DemoScenario,
  packServe: DemoServe,
  serves: readonly ContributedServe[],
  routes: readonly (readonly [string, RouteHandler])[],
  lastToastAt: { current: number | null },
): BrowserServer {
  return createBrowserServer({
    serve: (s) => {
      const owners = new Map<string, string>();
      const all: BrowserServed[] = [];
      for (const { source, serve } of [
        { source: `the pack of "${scenario.id}"`, serve: packServe },
        ...serves,
      ]) {
        all.push(...serve(claiming(s, source, owners, scenario.id)));
      }
      return all;
    },
    routes: routes.map(([key, handler]): [string, RouteHandler] => [
      key,
      handler,
    ]),
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
  serves,
  routes,
  children,
}: {
  scenario: DemoScenario;
  serves: readonly ContributedServe[];
  routes: readonly (readonly [string, RouteHandler])[];
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
    const built = buildServer(scenario, packServe, serves, routes, lastToastAt);
    setServer(built);
    return () => built.dispose();
  }, [scenario, packServe, serves, routes]);
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
 * `Demo.Resource` contribution's serves and every `Demo.Route` handler. Any
 * other known live key fails `loader-failed` (`DemoMissingError`); any other
 * `/api` request is refused (`unsupportedEndpointResponse`) with one
 * "Not available in the demo" toast at a time. The pack loading renders
 * `<Loading/>`; a pack that fails to load or parse, or a key served twice,
 * throws to the error boundary.
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
    <CollectServes resources={resources} index={0} acc={NO_SERVES}>
      {(serves) => (
        <Suspense fallback={<Loading />}>
          <ScopeServer scenario={scenario} serves={serves} routes={routes}>
            {children}
          </ScopeServer>
        </Suspense>
      )}
    </CollectServes>
  );
}
