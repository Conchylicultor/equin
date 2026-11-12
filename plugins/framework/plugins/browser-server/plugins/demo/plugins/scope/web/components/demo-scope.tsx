// <DemoScope>: a demo's own browser server — the scenario's host, a worker
// running the real portable server code of the host's composition on PGlite.
// Every read and request inside the scope reaches it, and nothing else: a
// `needsMachine` read or endpoint answers unavailable without reaching it, and
// everything else the scoped page reads, calls or registers is served by the
// host — the build's coverage guard (codegen's `browser-host-coverage.ts`)
// holds the host's graph to it. A key or endpoint it still does not serve is a
// gap the guard missed, and fails loudly (`loader-failed` naming the key, an
// `EndpointError` the reports collect), never a toast that hides it. Its
// frame documents (a prototype's `<iframe>`) load by URL from the same host,
// through the host's frame-serving Service Worker (`attachFrameServing`).

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PortHostRefusedError,
  portBrowserServer,
  type BrowserServer,
  type HostProgress,
  type PageInputValue,
  type PortEnd,
  type PortServer,
} from "@plugins/framework/plugins/browser-server/core";
import {
  attachFrameServing,
  browserServerTransport,
  HostInputs,
  hostBootReportSink,
  type FrameServing,
  type HostInputSupply,
} from "@plugins/framework/plugins/browser-server/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { DemoScenario } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import {
  foldResource,
  NotificationsProvider,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { hostDataStored } from "@plugins/framework/plugins/browser-server/plugins/host-storage/plugins/stored/core";
import { clearStorageScope } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { PLUGIN_SCOPE_ROOT_THEME } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  TransportProvider,
  useTransport,
} from "@plugins/primitives/plugins/networking/web";
import {
  PluginScope,
  useScopePlugins,
} from "@plugins/framework/plugins/web-sdk/core";
import { RenderOrigin } from "@plugins/primitives/plugins/scope/plugins/render-origin/web";
import { ScopeIconSymbols } from "@plugins/ui/plugins/icons/plugins/sprites/web";
import {
  connectDemoHost,
  trackHostGenerations,
  type HostGenerations,
} from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/prestart/web";
import { holdVisitorIn, visitorInElsewhere } from "../internal/presence";

// ── The host ───────────────────────────────────────────────────────────

/** The persisted log every host boot writes one line to (`logs/<this>.jsonl`). */
const BOOT_LOG_CHANNEL = "demo-host-boot";

/**
 * One host boot as a line: the wait the page saw (from asking for the host
 * module to the worker's `ready`) and when it asked (the page's clock, from
 * its navigation), then the worker's own account of it.
 */
function bootLine(
  scenarioId: string,
  askedAtMs: number,
  waitedMs: number,
  hosted: PortServer,
  frames: FrameServing,
): string {
  const { boot, readyAtMs } = hosted;
  const stages = boot.stages.map((s) => `${s.name} ${s.ms} ms`).join(", ");
  const slowest = boot.slowest.map((s) => `${s.label} ${s.ms} ms`).join(", ");
  const framed =
    frames.kind === "serving"
      ? `frames at ${frames.frameBase}`
      : `frames unsupported: ${frames.reason}`;
  // When the worker was created, on this page's clock: what the wait spent
  // before the worker ran at all (loading the host module, starting it).
  const created =
    boot.createdAt === undefined
      ? ""
      : `, worker created at ${Math.round(boot.createdAt - performance.timeOrigin)} ms`;
  return (
    `${scenarioId}: host ready in ${Math.round(waitedMs)} ms, asked at ${Math.round(askedAtMs)} ms${created} ` +
    `(worker ready at ${readyAtMs} ms: ${stages}; ${boot.plugins} plugins; data: ${boot.data ?? "none kept"}; ${framed}) — slowest: ${slowest}`
  );
}

/** A booted scope host: its server, where its frame documents load (`Transport.frameBase`), and its Reset. */
interface ScopeHost {
  server: BrowserServer;
  frameBase: string | null;
  reset(): void;
  /** Hand the host one page input's value (`PortServer.supply`). */
  supply(key: string, input: PageInputValue): void;
  /** Declare page inputs this page supplies (`PortServer.declareInputs`). */
  declareInputs(keys: readonly string[]): void;
}

/**
 * Why the host will not serve this page any more, each with its own message
 * (`STOPPED_MESSAGES`) — decided by the cause, never a catch-all.
 */
type StopReason =
  /** Another version of equin, loaded in another tab, holds the demo's data (or wrote it). */
  | "updated"
  /** This browser has no SharedWorker, and another tab's own host took the data. */
  | "unshared";

const STOPPED_MESSAGES: Record<StopReason, string> = {
  updated:
    "equin was updated in another tab. Reload this tab to continue on the new version.",
  unshared:
    "This browser cannot run the demo in two tabs at once, and it is now open in another tab. Reload to continue in this one.",
};

/** What one start of the scope's host comes to. */
interface ScopeStart {
  onReady(host: ScopeHost): void;
  /** The host will not serve this page (it declined, or another took its data): show why. */
  onStopped(why: StopReason): void;
  /** It ended under this page in a way the page follows (a Reset, a retirement): start again. */
  onFollow(why: "reset" | "retired"): void;
  onFailed(err: unknown): void;
  /** How far its boot has come, until it is ready. */
  onProgress(progress: HostProgress): void;
}

/**
 * The page's end of the scenario's host: ONE SharedWorker per build and host
 * generation for every tab of the demo (one server, one database — what keeps
 * a persistent host's data whole across tabs; `demo/prestart`'s
 * `connectDemoHost` for why a Reset, or a worker retiring once its last tab
 * went, moves to the next name), or, where the browser has none, a dedicated
 * worker of this page's own (the host's storage lock keeps a single owner).
 * The end is not started: the caller starts it once it listens.
 */
async function connectHost(
  scenario: DemoScenario,
  mod: Awaited<ReturnType<DemoScenario["host"]["start"]>>,
  generations: HostGenerations,
): Promise<{
  end: PortEnd;
  start(): void;
  generation: number;
  stop(): void;
}> {
  if (typeof SharedWorker === "function") {
    const { connection, generation } = await connectDemoHost(
      scenario.id,
      mod,
      generations,
    );
    return {
      end: connection.port,
      // `addEventListener` alone does not start a MessagePort.
      start: () => connection.port.start(),
      generation,
      stop: connection.leave,
    };
  }
  const worker = mod.start();
  return {
    end: worker,
    start: () => {},
    generation: generations.current(),
    stop: () => worker.terminate(),
  };
}

/**
 * Connect to the scenario's host — at its generation as of connecting, so a
 * Reset sent from another tab while the host module loads is not missed —
 * its frame serving attached alongside the boot — and report how it goes (`ScopeStart`); returns the
 * teardown (frame serving detached, the server disposed, this page's end of
 * the worker closed).
 */
function startScopeServer(
  scenario: DemoScenario,
  generations: HostGenerations,
  inputs: readonly string[],
  telemetry: boolean,
  report: ScopeStart,
): () => void {
  let ended = false;
  let stopEnd: (() => void) | null = null;
  let served: BrowserServer | null = null;
  let detachFrames: (() => void) | null = null;
  void (async () => {
    const asked = performance.now();
    const mod = await scenario.host.start();
    if (ended) return;
    let connected: Awaited<ReturnType<typeof connectHost>>;
    let framing: Promise<FrameServing>;
    let hosted: PortServer;
    // Until a worker serves this page: one that declines because the same
    // host already serves the data as another worker (`join`) sends this tab
    // there — a tab joins the running host, never takes it.
    for (;;) {
      connected = await connectHost(scenario, mod, generations);
      const { end, start, stop } = connected;
      stopEnd = stop;
      if (ended) {
        stop();
        return;
      }
      framing = attachFrameServing(end, mod.serviceWorkerUrl);
      try {
        const serving = portBrowserServer(end, {
          inputs,
          onProgress: (progress) => {
            if (!ended) report.onProgress(progress);
          },
        });
        // Listening now: what the host posted meanwhile is delivered.
        start();
        hosted = await serving;
        break;
      } catch (err) {
        if (!(err instanceof PortHostRefusedError)) throw err;
        // Nothing will be served on this end: the frames attached alongside go too.
        const frames = await framing;
        if (frames.kind === "serving") frames.detach();
        stop();
        stopEnd = null;
        if (ended) return;
        const refusal = err.refusal;
        switch (refusal.kind) {
          case "join": {
            const from = connected.generation;
            if (generations.join(refusal.worker) === from) {
              throw new Error(
                `[demo-scope] ${scenario.id}: the host at generation ${from} told this tab to join itself`,
              );
            }
            continue;
          }
          case "outdated":
            report.onStopped("updated");
            return;
        }
      }
    }
    const { generation } = connected;
    const frames: FrameServing = await framing;
    if (frames.kind === "serving") {
      if (ended) frames.detach();
      else detachFrames = frames.detach;
    }
    if (ended) return;
    const waitedMs = performance.now() - asked;
    const line = bootLine(scenario.id, asked, waitedMs, hosted, frames);
    console.info(`[demo-scope] ${line}`);
    clientLog(BOOT_LOG_CHANNEL, line);
    // The boot as its own measurement, once per boot: nothing reads the host
    // before `ready`, so no read's settle holds it — the consumer
    // (debug/slow-ops) judges it against its own budget.
    if (telemetry)
      hostBootReportSink.emit({
        host: scenario.id,
        waitedMs,
        askedAtMs: asked,
        boot: hosted.boot,
        readyAtMs: hosted.readyAtMs,
      });
    served = hosted.server;
    void hosted.ended.then((why) => {
      switch (why) {
        case "reset":
        case "retired":
          // Past this generation in every tab told so, whichever sent the
          // Reset (or: the worker retired — none of its pages should see
          // that, but a name it closed under is never asked for again
          // either way); then follow to the next host, on the same data or
          // the fresh one.
          generations.advance(generation);
          if (!ended) report.onFollow(why);
          return;
        case "updated":
        case "unshared":
          if (!ended) report.onStopped(why);
          return;
      }
    });
    report.onReady({
      server: served,
      frameBase: frames.kind === "serving" ? frames.frameBase : null,
      reset: () => {
        // Before the host is asked: a tab opened while it wipes already
        // connects to the next generation, never to the worker that closes.
        generations.advance(generation);
        hosted.reset();
      },
      supply: hosted.supply,
      declareInputs: hosted.declareInputs,
    });
  })().catch((err: unknown) => {
    if (!ended) report.onFailed(err);
  });
  return () => {
    ended = true;
    detachFrames?.();
    served?.dispose();
    stopEnd?.();
  };
}

/** The scope's host, as the subtree can act on it: `reset` wipes its data and boots it again from the seed. */
export interface DemoHostControl {
  reset(): void;
}

const DemoHostControlContext = createContext<DemoHostControl | null>(null);

/**
 * The enclosing `<DemoScope>`'s host control (Reset). Throws outside one: a
 * control rendered where no demo is cannot do anything.
 */
export function useDemoHostControl(): DemoHostControl {
  const control = useContext(DemoHostControlContext);
  if (control === null) {
    throw new Error("useDemoHostControl: rendered outside a <DemoScope>");
  }
  return control;
}

type ScopeState =
  /** Not started: a browser without the demo's data starts nothing until the visitor asks (`DemoBoot`'s `enter`). */
  | { kind: "idle" }
  | { kind: "booting"; progress: HostProgress | null }
  | { kind: "ready"; host: ScopeHost }
  /** The host will not serve this page: why, and a reload. */
  | { kind: "stopped"; why: StopReason }
  | { kind: "failed"; error: unknown };

/**
 * Where the scope is before the visitor is in the demo, as a page draws it
 * (`boot`):
 * - `checking` — not known yet whether the visitor is already in this demo
 *   in another tab of this browser (then this tab joins it, no gate): the
 *   page draws neither the gate nor a boot (a few ms);
 * - `gate` — the visitor has not asked for the demo yet (`enter`), on every
 *   visit — one that no other tab of this browser is in. Behind it the host may already be starting (this browser holds
 *   the demo's data, so starting downloads nothing large) or not (a first
 *   visit: entering downloads the server and its data);
 * - `starting` — the visitor entered and the host is still booting,
 *   `progress` its worker's report so far (`null` until the first arrives).
 */
export type DemoBoot =
  | { kind: "checking" }
  | { kind: "gate"; enter(): void }
  | { kind: "starting"; progress: HostProgress | null };

/**
 * How the visitor came into a gated demo: `"gate"` — they clicked Enter in
 * this tab; `"joined"` — this tab opened while they were in the demo in
 * another one (nothing was done in this tab).
 */
export type DemoEntry = "gate" | "joined";

/**
 * Renders `children` against the scenario's browser host — real server code
 * in a worker, on the scenario's data — and scoped to the host's composition
 * (`<PluginScope>`), so the page shows exactly what the worker serves.
 *
 * A page that draws `boot` gates the demo: the visitor enters it (the gate's
 * `enter`) on every visit, and `boot` draws the gate, then the boot until the
 * host serves (`DemoBoot`). A visit lasts while the visitor is in the demo in
 * any tab of this browser: a tab opened meanwhile — a link from inside opened
 * in a new tab, a second tab of the page — joins it with no gate (each tab
 * whose visitor is in holds a shared Web Lock, `internal/presence.ts`) —
 * unless the page's own URL says whether the visitor is in (`resume`), which
 * then decides alone.
 * `onEnter` hears the visitor come in either way, and which: `"gate"` is
 * this tab's visitor acting (a click — the page may answer it, by scrolling
 * to the demo), `"joined"` is this tab opening (no action here: a page must
 * not move for it). Behind the gate the host starts at once where
 * this browser holds the demo's data (`scenario.storage`, `hostDataStored`) —
 * so entering is instant — and only on `enter` otherwise, since the first
 * start downloads the whole server and its data. Without `boot`, the host
 * starts at once behind `<Loading/>`. A Reset never asks again: the visitor
 * asked for the demo back.
 *
 * Every tab shares the running host: a worker that finds the same host
 * already serving the data (another tab's, under another generation's name)
 * sends this tab to it (`join`), and a Reset or a retirement is followed to
 * the next host — never a screen. A host that fails to boot throws to the
 * error boundary. Only a cause the tab cannot follow stops it, each with its
 * own message and a Reload (`StopReason`): equin was updated in another tab,
 * or a browser without SharedWorker opened the demo in another tab.
 */
export function DemoScope({
  scenario,
  boot,
  onEnter,
  resume,
  children,
}: {
  scenario: DemoScenario;
  boot?: (state: DemoBoot) => ReactNode;
  /** The visitor came in: entered at the gate, or joined the demo another tab is in. Gated scopes only. */
  onEnter?: (how: DemoEntry) => void;
  /**
   * Whether the visitor is in the demo, as the page's own URL says — given,
   * the URL is the authority and no other tab is asked. `true` (the URL names
   * a place in the demo — a reload, a shared link, a tab opened from inside):
   * no gate, the host starts at once and `boot` draws only its loading, and
   * `onEnter` is not called — the page knew. `false` (a plain page): the gate,
   * even while the visitor is in the demo in another tab. Omitted: a page
   * whose URL cannot say — a tab joins the demo another tab is in.
   */
  resume?: boolean;
  children: ReactNode;
}): ReactNode {
  // Whether the scope's telemetry is reported — to the page's own server, the
  // enclosing page's setting (D3: a browser server has nowhere of its own to
  // keep it; `false` would drop it at every emission site).
  const { telemetry } = useTransport();
  // The page inputs this page can hand the host (`HostInputs.Supply`), read
  // from the PAGE's registry: values of the page's own server, never read by
  // the scope's code.
  const supplies = HostInputs.Supply.useContributions();
  const inputKeys = supplies.map((s) => s.value.key);
  // The keys known when a host starts are declared as it connects; a supply
  // that loads later (a deferred plugin tier) is declared then — never a
  // reason to restart the host.
  const inputKeysRef = useRef(inputKeys);
  // Read when a boot completes (its measurement is telemetry), never a reason
  // to restart the host.
  const telemetryRef = useRef(telemetry);
  useEffect(() => {
    inputKeysRef.current = inputKeys;
    telemetryRef.current = telemetry;
  });
  // A resumed visit is past the gate: the page's own URL says the visitor is in.
  const gated = boot !== undefined && resume !== true;
  // Whether the visitor is in the demo: at once without a gate (or resumed);
  // at the gate when the page's URL says they are not; else at once when
  // they are in it in another tab of this browser (`checking` until known),
  // or once they ask at the gate.
  const [visitor, setVisitor] = useState<"checking" | "gate" | "in">(
    !gated ? "in" : resume === false ? "gate" : "checking",
  );
  const [checkFailed, setCheckFailed] = useState<{ error: unknown } | null>(
    null,
  );
  const cameIn = useEventCallback((how: DemoEntry) => onEnter?.(how));
  // Whether the host may start: once the visitor entered, or behind the gate
  // once this browser is found to hold the data (nothing large to download).
  const [started, setStarted] = useState(!gated);
  const [state, setState] = useState<ScopeState>(
    gated ? { kind: "idle" } : { kind: "booting", progress: null },
  );
  useEffect(() => {
    if (started || scenario.storage === null) return;
    let live = true;
    hostDataStored(scenario.storage).then(
      (held) => {
        if (live && held) setStarted(true);
      },
      (error: unknown) => {
        if (live) setState({ kind: "failed", error });
      },
    );
    return () => {
      live = false;
    };
  }, [started, scenario.storage]);
  useEffect(() => {
    if (visitor !== "checking") return;
    let live = true;
    visitorInElsewhere(scenario.id).then(
      (elsewhere) => {
        if (!live) return;
        if (!elsewhere) {
          setVisitor("gate");
          return;
        }
        setVisitor("in");
        setStarted(true);
        cameIn("joined");
      },
      (error: unknown) => {
        if (live) setCheckFailed({ error });
      },
    );
    return () => {
      live = false;
    };
  }, [visitor, scenario.id, cameIn]);
  // While the visitor is in, this tab says so to every other one.
  useEffect(() => {
    if (visitor !== "in") return;
    return holdVisitorIn(scenario.id);
  }, [visitor, scenario.id]);
  // Bumped when the host is reset, to start a fresh one (on the host
  // generation the reset moved every tab to).
  const [resets, setResets] = useState(0);
  /** The resets whose browser-side state was already thrown away. */
  const clearedResets = useRef(0);
  // Bumped when the host retired under this page (none should), to connect
  // to the next one — on the same data.
  const [reconnects, setReconnects] = useState(0);
  const generations = useMemo(
    () => trackHostGenerations(scenario.id),
    [scenario.id],
  );
  useEffect(() => {
    if (!started) return;
    // A reset throws away the scope's browser-side state with its data (the
    // drafts and view state its plugins kept in Web Storage, in every tab):
    // here, once the old subtree has unmounted and written its last.
    if (resets > clearedResets.current) {
      clearStorageScope(scenario.host.id);
      clearedResets.current = resets;
    }
    // Started here, not in a useState initialiser: the host is a disposable
    // resource owned by this mount, so StrictMode's mount → unmount → mount
    // ends the first and keeps the second (an initialiser would start one a
    // discarded render never ends).
    const stop = startScopeServer(
      scenario,
      generations,
      inputKeysRef.current,
      telemetryRef.current,
      {
      onReady: (host) => setState({ kind: "ready", host }),
      onStopped: (why) => setState({ kind: "stopped", why }),
      onFollow: (why) => {
        setState({ kind: "booting", progress: null });
        if (why === "reset") setResets((r) => r + 1);
        else setReconnects((r) => r + 1);
      },
      onFailed: (error) => setState({ kind: "failed", error }),
      onProgress: (progress) =>
        setState((prev) =>
          // `idle` until the first report: the host was not started before.
          prev.kind === "booting" || prev.kind === "idle"
            ? { kind: "booting", progress }
            : prev,
        ),
    });
    return () => {
      stop();
      // The next server (a host still booting) is not this one.
      setState({ kind: "booting", progress: null });
    };
  }, [started, scenario, generations, resets, reconnects]);
  // The scope's web plugins this page holds on demand (a page whose own
  // composition lacks the demo's apps — the standalone site), loaded alongside
  // the host's boot, once the host may start: nothing before the gate on a
  // first visit.
  const scopePlugins = useScopePlugins(scenario.host, started);
  const host = state.kind === "ready" ? state.host : null;
  const declaredKeys = inputKeys.join("\n");
  useEffect(() => {
    // Additive on the host's side: re-declaring a key is a no-op.
    if (host !== null && declaredKeys !== "")
      host.declareInputs(declaredKeys.split("\n"));
  }, [host, declaredKeys]);
  const transport = useMemo(
    () =>
      host === null
        ? null
        : browserServerTransport(host.server, {
            telemetry,
            frameBase: host.frameBase,
          }),
    [host, telemetry],
  );
  const control = useMemo<DemoHostControl | null>(
    () => (host === null ? null : { reset: host.reset }),
    [host],
  );
  // Only a gated scope (`boot` set) is ever outside. The gate comes first: a
  // host started behind it (stored data) that failed or was declined says so
  // once the visitor enters, never in place of the gate.
  if (checkFailed !== null) throw checkFailed.error;
  if (visitor === "checking" && boot !== undefined)
    return boot({ kind: "checking" });
  if (visitor === "gate" && boot !== undefined) {
    return boot({
      kind: "gate",
      enter: () => {
        setVisitor("in");
        setStarted(true);
        cameIn("gate");
      },
    });
  }
  // A host that could not boot reaches the error boundary, never an empty app.
  if (state.kind === "failed") throw state.error;
  if (scopePlugins.kind === "failed") throw scopePlugins.error;
  if (state.kind === "stopped") return <HostStopped why={state.why} />;
  if (
    transport === null ||
    control === null ||
    scopePlugins.kind === "pending"
  ) {
    if (boot === undefined) return <Loading />;
    return boot({
      kind: "starting",
      progress: state.kind === "booting" ? state.progress : null,
    });
  }
  return (
    <DemoHostControlContext.Provider value={control}>
      {/* Outside the scope's transport: each reads the page's own server. */}
      {host !== null &&
        supplies.map((supply) => (
          <PageInputFeed key={supply.value.key} supply={supply} host={host} />
        ))}
      <TransportProvider transport={transport}>
        <NotificationsProvider>
          <PluginScope composition={scenario.host}>
            {/* The scope's saved icons are drawn from the host — never
                asked of the page's sprite host, which reads the page's
                server. */}
            <ScopeIconSymbols>
              {/* The scope's own `:root`: its base theme, painted by the
                  scope's theme hosts (`PLUGIN_SCOPE_ROOT_THEME`, qualified by
                  the scope) — so nothing the page's `:root` declares reaches
                  the demo's glue. `contents`: a theme region, not a box. */}
              <Theme
                name={PLUGIN_SCOPE_ROOT_THEME}
                surface="none"
                className="contents"
              >
                {/* What the scope's code hands to page chrome (a toast's body,
                    an imperative dialog) renders here, against the host —
                    never in the page's tree, against the page's server. */}
                <RenderOrigin>{children}</RenderOrigin>
              </Theme>
            </ScopeIconSymbols>
          </PluginScope>
        </NotificationsProvider>
      </TransportProvider>
    </DemoHostControlContext.Provider>
  );
}

/**
 * One page input, fed to the host: the page's own read of the value (on the
 * page's transport — this renders outside the scope), handed over each time
 * it settles. Renders nothing.
 */
function PageInputFeed({
  supply,
  host,
}: {
  supply: HostInputSupply;
  host: ScopeHost;
}): ReactNode {
  const read = useLive(supply.value);
  const key = supply.value.key;
  // What the page knows, once it knows it. A read keeps its identity until
  // its state changes, so this — and the send below — moves only then.
  const input = useMemo(
    () =>
      foldResource<typeof read, PageInputValue | null>(read, {
        loading: () => null,
        error: (error) => ({ kind: "failed", message: error.message }),
        ready: (value) => ({ kind: "value", value }),
      }),
    [read],
  );
  useEffect(() => {
    if (input !== null) host.supply(key, input);
  }, [host, key, input]);
  return null;
}

/** Why the host does not serve this page, and the way out. `data-demo-stopped`: the cause, for e2e. */
function HostStopped({ why }: { why: StopReason }): ReactNode {
  return (
    <Center className="h-full p-lg" data-demo-stopped={why}>
      <Stack gap="md" align="center">
        <Text as="p" variant="body" tone="muted">
          {STOPPED_MESSAGES[why]}
        </Text>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </Stack>
    </Center>
  );
}
