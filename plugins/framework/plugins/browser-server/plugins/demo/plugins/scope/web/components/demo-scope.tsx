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
  type HostEndReason,
  type PageInputValue,
  type PortEnd,
  type PortServer,
} from "@plugins/framework/plugins/browser-server/core";
import {
  attachFrameServing,
  browserServerTransport,
  HostInputs,
  type FrameServing,
  type HostInputSupply,
} from "@plugins/framework/plugins/browser-server/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { DemoScenario } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import {
  foldResource,
  NotificationsProvider,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { clearStorageScope } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  TransportProvider,
  useTransport,
} from "@plugins/primitives/plugins/networking/web";
import { PluginScope } from "@plugins/framework/plugins/web-sdk/core";
import { RenderOrigin } from "@plugins/primitives/plugins/scope/plugins/render-origin/web";
import { ScopeIconSymbols } from "@plugins/ui/plugins/icons/plugins/sprites/web";

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
  frames: FrameServing,
): string {
  const { boot, readyAtMs } = hosted;
  const stages = boot.stages.map((s) => `${s.name} ${s.ms} ms`).join(", ");
  const slowest = boot.slowest.map((s) => `${s.label} ${s.ms} ms`).join(", ");
  const framed =
    frames.kind === "serving"
      ? `frames at ${frames.frameBase}`
      : `frames unsupported: ${frames.reason}`;
  return (
    `${scenarioId}: host ready in ${Math.round(waitedMs)} ms ` +
    `(worker ready at ${readyAtMs} ms: ${stages}; ${boot.plugins} plugins; data: ${boot.data ?? "none kept"}; ${framed}) — slowest: ${slowest}`
  );
}

/** A booted scope host: its server, where its frame documents load (`Transport.frameBase`), and its Reset. */
interface ScopeHost {
  server: BrowserServer;
  frameBase: string | null;
  reset(): void;
  /** What the host asks this page to tell the person about its boot (`HostBooted.notice`). */
  notice: string | null;
  /** Hand the host one page input's value (`PortServer.supply`). */
  supply(key: string, input: PageInputValue): void;
  /** Declare page inputs this page supplies (`PortServer.declareInputs`). */
  declareInputs(keys: readonly string[]): void;
}

/** What one start of the scope's host comes to. */
interface ScopeStart {
  onReady(host: ScopeHost): void;
  /** The host declined to boot (`PortHostRefusedError`): show `message`. */
  onRefused(message: string): void;
  /** It stopped serving after it was ready. */
  onEnded(why: HostEndReason): void;
  onFailed(err: unknown): void;
}

/**
 * The page's end of the scenario's host: ONE SharedWorker per build for every
 * tab of the demo (one server, one database — what keeps a persistent host's
 * data whole across tabs), or, where the browser has none, a dedicated worker
 * of this page's own (the host's storage lock keeps a single owner).
 */
function connectHost(
  mod: Awaited<ReturnType<DemoScenario["host"]["start"]>>,
  scenarioId: string,
): { end: PortEnd; stop(): void } {
  if (typeof SharedWorker === "function") {
    const shared = mod.startShared(scenarioId);
    // `addEventListener` alone does not start a MessagePort.
    shared.port.start();
    return { end: shared.port, stop: () => shared.port.close() };
  }
  const worker = mod.start();
  return { end: worker, stop: () => worker.terminate() };
}

/**
 * Connect to the scenario's host — its frame serving attached alongside the
 * boot — and report how it goes (`ScopeStart`); returns the teardown (frame
 * serving detached, the server disposed, this page's end of the worker
 * closed).
 */
function startScopeServer(
  scenario: DemoScenario,
  inputs: readonly string[],
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
    const { end, stop } = connectHost(mod, scenario.id);
    stopEnd = stop;
    const framing = attachFrameServing(end, mod.serviceWorkerUrl);
    let hosted: PortServer;
    try {
      hosted = await portBrowserServer(end, { inputs });
    } catch (err) {
      if (err instanceof PortHostRefusedError) {
        // Nothing will be served: the frames attached alongside go too.
        const frames = await framing;
        if (frames.kind === "serving") frames.detach();
        if (!ended) report.onRefused(err.message);
        return;
      }
      throw err;
    }
    const frames: FrameServing = await framing;
    if (frames.kind === "serving") {
      if (ended) frames.detach();
      else detachFrames = frames.detach;
    }
    if (ended) return;
    const line = bootLine(
      scenario.id,
      performance.now() - asked,
      hosted,
      frames,
    );
    console.info(`[demo-scope] ${line}`);
    clientLog(BOOT_LOG_CHANNEL, line);
    served = hosted.server;
    void hosted.ended.then((why) => {
      if (!ended) report.onEnded(why);
    });
    report.onReady({
      server: served,
      frameBase: frames.kind === "serving" ? frames.frameBase : null,
      reset: hosted.reset,
      notice: hosted.notice,
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
  | { kind: "booting" }
  | { kind: "ready"; host: ScopeHost }
  /** The host will not serve this page: a message and a reload. */
  | { kind: "stopped"; message: string }
  | { kind: "failed"; error: unknown };

const SUPERSEDED_MESSAGE =
  "This demo was opened in another tab, or updated there. Reload this tab to continue here.";

/**
 * Renders `children` against the scenario's browser host — real server code
 * in a worker, on the scenario's data — and scoped to the host's composition
 * (`<PluginScope>`), so the page shows exactly what the worker serves. The
 * host booting renders `<Loading/>`; a host that fails to boot throws to the
 * error boundary. A host that declines this page (its data written by a newer
 * version) or stops serving it (another tab took it over) shows why, with a
 * Reload; a Reset (`useDemoHostControl`, from any tab) boots it again.
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
  // The page inputs this page can hand the host (`HostInputs.Supply`), read
  // from the PAGE's registry: values of the page's own server, never read by
  // the scope's code.
  const supplies = HostInputs.Supply.useContributions();
  const inputKeys = supplies.map((s) => s.value.key);
  // The keys known when a host starts are declared as it connects; a supply
  // that loads later (a deferred plugin tier) is declared then — never a
  // reason to restart the host.
  const inputKeysRef = useRef(inputKeys);
  useEffect(() => {
    inputKeysRef.current = inputKeys;
  });
  const [state, setState] = useState<ScopeState>({ kind: "booting" });
  // Bumped when the host is reset, to start a fresh one.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    // A reset throws away the scope's browser-side state with its data (the
    // drafts and view state its plugins kept in Web Storage, in every tab):
    // here, once the old subtree has unmounted and written its last.
    if (generation > 0) clearStorageScope(scenario.host.id);
    // Started here, not in a useState initialiser: the host is a disposable
    // resource owned by this mount, so StrictMode's mount → unmount → mount
    // ends the first and keeps the second (an initialiser would start one a
    // discarded render never ends).
    const stop = startScopeServer(scenario, inputKeysRef.current, {
      onReady: (host) => setState({ kind: "ready", host }),
      onRefused: (message) => setState({ kind: "stopped", message }),
      onEnded: (why) => {
        if (why === "reset") {
          setState({ kind: "booting" });
          setGeneration((g) => g + 1);
        } else {
          setState({ kind: "stopped", message: SUPERSEDED_MESSAGE });
        }
      },
      onFailed: (error) => setState({ kind: "failed", error }),
    });
    return () => {
      stop();
      // The next server (a host still booting) is not this one.
      setState({ kind: "booting" });
    };
  }, [scenario, generation]);
  const host = state.kind === "ready" ? state.host : null;
  const declaredKeys = inputKeys.join("\n");
  useEffect(() => {
    // Additive on the host's side: re-declaring a key is a no-op.
    if (host !== null && declaredKeys !== "")
      host.declareInputs(declaredKeys.split("\n"));
  }, [host, declaredKeys]);
  // The notice of the boot this page waited for, until the person dismisses it.
  const [dismissed, setDismissed] = useState<ScopeHost | null>(null);
  const notice = host !== null && dismissed !== host ? host.notice : null;
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
  // A host that could not boot reaches the error boundary, never an empty app.
  if (state.kind === "failed") throw state.error;
  if (state.kind === "stopped") return <HostStopped message={state.message} />;
  if (transport === null || control === null) return <Loading />;
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
            {notice !== null && (
              <HostNotice
                message={notice}
                onDismiss={() => setDismissed(host)}
              />
            )}
            {/* The scope's saved icons are drawn from the host — never
                asked of the page's sprite host, which reads the page's
                server. */}
            <ScopeIconSymbols>
              {/* What the scope's code hands to page chrome (a toast's body,
                  an imperative dialog) renders here, against the host —
                  never in the page's tree, against the page's server. */}
              <RenderOrigin>{children}</RenderOrigin>
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

/** What the host asked this page to tell the person (a demo reset to a newer version), dismissible. */
function HostNotice({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): ReactNode {
  return (
    <Center className="px-md py-sm" data-host-notice="">
      <Stack direction="row" gap="sm" align="center">
        <Text as="p" variant="body" tone="muted" role="status">
          {message}
        </Text>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </Stack>
    </Center>
  );
}

/** Why the host does not serve this page, and the way out. */
function HostStopped({ message }: { message: string }): ReactNode {
  return (
    <Center className="h-full p-lg">
      <Stack gap="md" align="center">
        <Text as="p" variant="body" tone="muted">
          {message}
        </Text>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </Stack>
    </Center>
  );
}
