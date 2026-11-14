import { useState, useEffect } from "react";
import {
  PluginProvider,
  createPluginRegistry,
  Core,
  loadPlugins,
  partitionWebEntries,
  markDeferredPluginsLoaded,
  markDeferredLoadComplete,
  markDeferredPluginsFailed,
  missingCompanions,
  pluginLoadReportSink,
  hasFirstPaintHolds,
  takeFirstPaintHolds,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  LoadedPlugin,
  OnDemandPlugins,
  PluginLoadError,
  PluginRegistry,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  RenderCoreRoot,
  RenderScopeRoot,
} from "@plugins/primitives/plugins/slot-render/web";
import { normalizeRoutePath } from "@plugins/primitives/plugins/pane/core";
import {
  NotificationsProvider,
  ensureNotificationsClient,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { TransportProvider } from "@plugins/primitives/plugins/networking/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { yieldToMain } from "@plugins/primitives/plugins/perfs/plugins/scheduler/web";
import {
  startBootSpan,
  markBootInstant,
  markBootInstantAtNextCommit,
  traceBootPluginLoad,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import {
  DEFERRED_LOAD_COMPLETE_ID,
  FIRST_DATA_COMMIT_ID,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import type { BootPluginLoadDetail } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import { report } from "@plugins/reports/web";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import {
  composition,
  webEntries,
  webScopedEntries,
} from "@composition-web-registry";
import { appRootOf } from "@plugins/apps-core/plugins/app-preload/core";
import { PluginLoadErrors } from "./components/plugin-load-errors";
import { BootScreen } from "./components/boot-screen";
import {
  runBootTasks,
  type BootTask,
  type BootTaskProblem,
  type BootTaskStatus,
} from "./boot-tasks";

// The concrete registry-entry type (`{ pluginPath, id, loader, dependsOn }`) —
// carries the non-optional `id` we need to map a loaded plugin back to its path.
type WebEntry = (typeof webEntries)[number];

// Deferred plugin chunks evaluated per batch before yielding the main thread.
// Small enough that one batch never monopolizes the thread (so the queued
// leader-election socket grant + paint can interleave), large enough that the
// whole deferred tier still drains quickly.
const DEFERRED_BATCH_SIZE = 24;

// Every Core.Boot readiness task the plugins contribute, run before they
// register so they can hydrate caches the initial render depends on (e.g.
// config — replacing per-component Suspense). Enumerated from the raw
// contributions because PluginProvider (and useContributions) isn't mounted yet.
// `runBootTasks` bounds them by a deadline and tracks each one's status, which
// the boot screen renders.
type LoadResult = Awaited<ReturnType<typeof loadPlugins>>;

function bootTasksOf(plugins: LoadedPlugin[]): BootTask[] {
  return plugins.flatMap((p) =>
    (p.contributions ?? [])
      .filter((c) => c._slot === Core.Boot)
      .map((c) => c as unknown as BootTask),
  );
}

/**
 * The page's on-demand plugins (`webScopedEntries`: a bundled browser host's
 * page scope beyond the page's own plugins — empty on main, which bundles
 * them all), loaded into `registry` when a `<PluginScope>` asks
 * (`useScopePlugins`). Each loads once; a failed load rejects every caller
 * waiting on it, and a later ask tries it again. None may contribute a
 * `Core.Boot` task: it would run against the page's server, which does not
 * serve the scope.
 */
function createOnDemandPlugins(
  entries: readonly WebEntry[],
  registry: PluginRegistry,
): OnDemandPlugins {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const loaded = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const loadBatch = async (batch: WebEntry[]): Promise<void> => {
    const { plugins, errors } = await loadPlugins(batch);
    const booting = plugins.filter((p) => bootTasksOf([p]).length > 0);
    if (booting.length > 0) {
      throw new Error(
        `[plugins] on-demand plugin(s) contribute a Core.Boot task, which would run against the page's server: ${booting.map((p) => p.id).join(", ")}`,
      );
    }
    registry.append(plugins);
    markDeferredPluginsLoaded(plugins.map((p) => p.id));
    for (const p of plugins) loaded.add(p.id);
    if (errors.length > 0) {
      recordErrors(errors);
      throw new Error(
        `[plugins] ${errors.length} on-demand plugin(s) failed to load: ${errors.map((e) => e.pluginPath).join(", ")}`,
      );
    }
  };
  return {
    ids: new Set(byId.keys()),
    isLoaded: (id) => loaded.has(id),
    async load(ids) {
      const batch: WebEntry[] = [];
      const waits: Promise<void>[] = [];
      for (const id of ids) {
        if (loaded.has(id)) continue;
        const running = inFlight.get(id);
        if (running !== undefined) {
          waits.push(running);
          continue;
        }
        const entry = byId.get(id);
        if (entry === undefined) {
          throw new Error(
            `[plugins] "${id}" is not one of this page's on-demand plugins`,
          );
        }
        batch.push(entry);
      }
      if (batch.length > 0) {
        const run = loadBatch(batch).finally(() => {
          for (const e of batch) inFlight.delete(e.id);
        });
        for (const e of batch) inFlight.set(e.id, run);
        waits.push(run);
      }
      await Promise.all(waits);
    },
  };
}

// A companion the repo provides that this bundle lacks (see
// `missingCompanions`): the capability that needs it degrades with no error of
// its own, so this is the only signal. Same funnel as a boot problem.
function reportMissingCompanion(message: string): void {
  console.error(`[companions] ${message}`);
  void report({
    kind: "crash",
    source: "client-missing-companion",
    message,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: {
      errorType: "MissingCompanion",
      stack: new Error(message).stack ?? null,
    },
  });
}

// The boot sequence itself threw before the app rendered. Same funnel as a
// boot problem — and for the same reason a direct POST: no plugin (the crash
// collector included) may have loaded yet.
function reportBootCrash(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[boot] the app failed to start", err);
  void report({
    kind: "crash",
    source: "client-boot-crash",
    message: `boot: ${message}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: { ...crashFieldsOf(err) },
  });
}

// A failed or overdue boot task, into the alert funnel. `report()` is a direct
// keepalive POST: the crash collector's window listeners are not mounted during
// boot. In a fully wedged backend this POST may stall too — the server's own
// span-stuck traces cover that side, and this lands once the backend answers.
function reportBootProblem({ task, elapsedMs }: BootTaskProblem): void {
  const failed = task.outcome.kind === "failed" ? task.outcome : null;
  const message = failed
    ? `boot: "${task.label}" failed: ${failed.message}`
    : `boot: "${task.label}" still pending after ${Math.round(elapsedMs / 1000)}s`;
  console.error(`[boot] ${message}`);
  void report({
    kind: "crash",
    source: "client-boot-task",
    message,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: {
      errorType: failed ? "BootTaskFailed" : "BootTaskOverdue",
      label: task.label,
      // No Error is thrown for an overdue task; a minimal stack fingerprints it.
      stack: new Error(message).stack ?? null,
    },
  });
}

// Derive the deep-linked app's root prefix (`apps/plugins/<app>/`) from the
// current URL and the eager-loaded `Apps.App` contributions, so the deferred
// loader can front-load that app's content. We read the RAW contributions (the
// plugins have loaded but PluginProvider hasn't stamped `_pluginId` yet), so we
// recover each contribution's owning `pluginPath` via the entry `id → pluginPath`
// map. Returns null when the URL matches no app (e.g. bare `/`), leaving every
// deferred entry in the order-preserving "rest" tier.
function resolveActiveAppPrefix(
  eagerPlugins: LoadedPlugin[],
  eagerEntries: WebEntry[],
): string | null {
  const idToPath = new Map(
    eagerEntries.map((e) => [e.id, e.pluginPath] as const),
  );
  const apps: { path: string; pluginPath: string }[] = [];
  // A surface-mode app's base path is a route PREFIX, not a route: in front of
  // the focused tab's own URL (`/desktop/agents/c/x` is the agent manager, shown
  // on the desktop). Same shape test — its entry carries `surfaceMode`.
  const prefixes: string[] = [];
  for (const p of eagerPlugins) {
    const pluginPath = idToPath.get(p.id);
    if (!pluginPath) continue;
    for (const c of p.contributions ?? []) {
      // Identified by SHAPE, not by slot id. This runs before `PluginProvider`,
      // so no declaration pass has settled any slot's id yet — and it is also
      // what removes the last hand-typed slot id from the framework, along with
      // the `web-core` → `apps-core` coupling that string stood for.
      //
      // An `Apps.App` contribution carries the app's whole `AppRef` (`{ id,
      // name, basePath, iconKey }`) and restates nothing about it, so the base
      // path is read off `c.app`. Nothing else contributes an `app` carrying a
      // `basePath` (a pane registration carries `pane`), so the narrowing below
      // IS the identification. Kept defensive (`unknown` narrowing rather than a
      // cast): this runs pre-boot on raw, unstamped, untyped values.
      const app = c.app as { basePath?: unknown } | undefined;
      if (typeof app?.basePath === "string") {
        apps.push({ path: app.basePath, pluginPath });
        if (typeof c.surfaceMode === "string") prefixes.push(app.basePath);
      }
    }
  }
  // Longest-path-prefix match against the URL — inlined rather than reusing
  // apps-core's matchAppForPath, whose `ActiveApp` param is the *sealed*
  // contribution shape (its `component` is opaque), which fights our raw
  // unsealed contributions. The match logic is identical (see resolve-app.ts).
  // eslint-disable-next-line pane/no-raw-location-path -- pre-boot: `currentRoutePath()` lives in pane/web, which this eager boot root must not pull in; the pure core normalizer is the same canonicalization.
  const raw = normalizeRoutePath(window.location.pathname);
  // Bare, the prefix is that app's own page (the empty desktop): matched as is.
  const prefix = prefixes.find((p) => raw.startsWith(p + "/"));
  const pathname = prefix === undefined ? raw : raw.slice(prefix.length);
  const matched = [...apps]
    .sort((a, b) => b.path.length - a.path.length)
    .find(
      (a) =>
        pathname === a.path ||
        pathname.startsWith(a.path + "/") ||
        // An app's landing pane writes its keyed suffix on the base path.
        pathname.startsWith(a.path + ";"),
    );
  if (!matched) return null;
  // The matched contribution's pluginPath is the app's shell dir
  // (apps/plugins/<app>/plugins/shell); its root apps/plugins/<app>/ holds all
  // its deferred content — the same root the served head preloads it by
  // (apps-core/app-preload).
  return appRootOf(matched.pluginPath);
}

// Publish a batch's load failures on the deferred-load signal (so consumers can
// distinguish "plugin chunk failed" from "not resolvable yet", and the Build
// button's Reload chip can turn red) and fire one report per failure (the
// reports plugin files a crash task). Called for BOTH stages — whether a failure
// also gets the boot banner is decided by which state it lands in, not here.
// No-op on success.
function recordErrors(errors: PluginLoadError[]): void {
  if (errors.length === 0) return;
  markDeferredPluginsFailed(errors.map((e) => e.pluginPath));
  for (const e of errors) {
    const message =
      e.error instanceof Error ? e.error.message : String(e.error);
    pluginLoadReportSink.emit({ pluginPath: e.pluginPath, message });
  }
}

// Where boot is. There is no "nothing to show" state: until `ready`, App
// renders the boot screen — loading the code, then waiting on the boot tasks
// (and, when a blocking one fails or runs late, saying so loudly).
type BootState =
  | { phase: "loading-code" }
  | {
      phase: "boot-tasks";
      tasks: readonly BootTaskStatus[];
      continueAnyway: () => void;
    }
  // The boot sequence threw before `ready` (e.g. the page transport needs an API
  // this browser lacks): nothing will move it on, so it is a terminal error.
  | { phase: "crashed"; message: string }
  | {
      phase: "ready";
      // Core-stage (eager) load errors ONLY — set once from the eager result and
      // never appended. Those broke something that painted before the user could
      // do anything, so they get the explicit banner. A deferred failure never
      // lands here: it is published by `recordErrors` alone, where the Build
      // button's Reload chip and the app's own "Couldn't load" pane pick it up.
      coreErrors: PluginLoadError[];
    };

/**
 * The page root: everything below resolves the page's own server through
 * `useTransport()` — the context has no default, so this is the one place the
 * page's transport is mounted (a demo scope points its subtree elsewhere).
 */
export default function App() {
  return (
    <TransportProvider transport={pageTransport}>
      <PageApp />
    </TransportProvider>
  );
}

function PageApp() {
  const [state, setState] = useState<BootState>({ phase: "loading-code" });
  // The plugin set lives in the registry, NOT in React state: appending a batch
  // re-renders only the readers of the slots it changed, never App and never
  // the whole tree. Created once per App mount.
  const [registry] = useState(createPluginRegistry);
  const [onDemand] = useState(() =>
    createOnDemandPlugins(webScopedEntries, registry),
  );
  // Resolves once the first app frame has committed: the deferred tier's
  // drain waits on it, so its evaluation never competes with that render.
  const [appCommitted] = useState(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  });
  const ready = state.phase === "ready";
  useEffect(() => {
    if (ready) appCommitted.resolve();
  }, [ready, appCommitted]);

  useEffect(() => {
    let cancelled = false;

    // Append a freshly-loaded batch to the registry (it registers only the
    // newcomers and notifies only the readers of slots whose list changed), then
    // publish the loaded ids on the deferred-load signal for the layout host.
    // Takes no errors on purpose: a deferred batch's failures have no way into
    // the banner's state.
    const appendPlugins = (plugins: LoadedPlugin[]) => {
      registry.append(plugins);
      markDeferredPluginsLoaded(plugins.map((p) => p.id));
    };

    // The active app's content is on screen at the first render: its priority
    // batch registers with the eager tier, before the boot screen gives way
    // (or, past Continue anyway, at the commit that registers it).
    const markRouteContentAtNextCommit = () =>
      markBootInstantAtNextCommit(
        ROUTE_CONTENT_COMMIT_ID,
        "paint",
        "First commit with the active app's content",
      );

    // Each plugin import timed per tier (boot-trace's per-plugin User Timing),
    // so a load can be split into which plugins it waited on.
    const traced = (
      batch: WebEntry[],
      tier: BootPluginLoadDetail["tier"],
    ): WebEntry[] =>
      batch.map((e) => ({
        ...e,
        loader: () => traceBootPluginLoad(e.pluginPath, tier, e.loader),
      }));

    // Register a loaded app-content batch: run any Core.Boot tasks its
    // plugins contribute (none under apps/ today, but correct + future-proof)
    // before they register, mirroring the eager path so hydration lands before
    // the slot re-render. Nothing holds here: a failed / overdue task is
    // reported. Its load failures are deferred ones — published (the app's own
    // "Couldn't load" pane, the Reload chip), never the core-error banner.
    const registerBatch = async ({ plugins, errors }: LoadResult) => {
      await runBootTasks(bootTasksOf(plugins), {
        holdOnBlocking: false,
        onProblem: reportBootProblem,
      }).settled;
      if (cancelled) return;
      appendPlugins(plugins);
      recordErrors(errors);
    };

    const loadDeferredBatch = async (batch: WebEntry[]): Promise<void> => {
      if (batch.length === 0) return;
      // Partial failure is tolerable (loadPlugins uses allSettled + collects
      // errors), so a broken app-content chunk never aborts the tier.
      const loaded = await loadPlugins(traced(batch, "deferred"));
      if (cancelled) return;
      await registerBatch(loaded);
    };

    // Whether the app has rendered: a throw before that leaves nothing on screen
    // but the boot screen, which must then say so instead of waiting forever.
    let rendered = false;

    void (async () => {
      // Layer 1 — Transport hoist. Construct the page transport's live-state
      // pipeline NOW, before any plugin evaluation, so its leader-election lock
      // request is queued at t≈0 and the socket opens during a loadPlugins await
      // gap instead of ~8s later. The root NotificationsProvider (under the
      // same transport) reuses this pipeline. Constructing it opens nothing;
      // `connect()` opens the worktree socket now.
      ensureNotificationsClient(pageTransport).connect();

      // Layer 3 — partition the registry into the eager substrate (chrome,
      // providers, app shells) and deferred app content.
      const { eager, deferred } = partitionWebEntries(webEntries);

      // Eager tier: load → boot tasks → paint. Chrome renders and
      // NotificationsProvider mounts (the socket is already warming from Layer 1).
      const endLoad = startBootSpan(
        "load-plugins",
        "scripts",
        "loadPlugins (eager)",
      );
      const eagerResult = await loadPlugins(traced(eager, "eager"));
      endLoad();

      // Layer 3 — the active app's content, loaded NOW, alongside the boot
      // tasks, and committed with the first frame: the page's head preloads
      // its modules from t0 (apps-core/app-preload), so importing them is
      // mostly evaluation, and the app paints whole — never its chrome first
      // and its content a beat later. Only the rest of the deferred tier waits
      // for after the first paint. It is a boot task of its own ("App code"),
      // so the boot screen names it while it is pending, an overdue one is
      // reported, and Continue anyway paints without it.
      const activePrefix = resolveActiveAppPrefix(eagerResult.plugins, eager);
      const priority: WebEntry[] = [];
      const rest: WebEntry[] = [];
      for (const e of deferred) {
        if (activePrefix && e.pluginPath.startsWith(activePrefix))
          priority.push(e);
        else rest.push(e);
      }
      // No app content (a path outside every app) is loaded from the start.
      // Partial failure is tolerable (allSettled + collected errors): a broken
      // app-content chunk is reported, never fails the boot.
      const appCode: { loaded: LoadResult | null } = {
        loaded: priority.length === 0 ? { plugins: [], errors: [] } : null,
      };
      const appCodeLoad = loadPlugins(traced(priority, "priority")).then(
        (loaded) => (appCode.loaded = loaded),
      );
      // The task also waits for what the app's code, while it evaluates, asks
      // the first frame to hold for (web-sdk's first-paint holds: a code-split
      // page body the URL shows), so the app still paints whole.
      const appCodeTask: BootTask[] =
        priority.length === 0 && !hasFirstPaintHolds()
          ? []
          : [
              {
                label: "App code",
                ifUnavailable: "block",
                run: async () => {
                  await appCodeLoad;
                  await takeFirstPaintHolds();
                },
              },
            ];
      const endBoot = startBootSpan(
        "boot-tasks",
        "boot-tasks",
        "runBootTasks (eager)",
      );
      const bootRun = runBootTasks(
        [...bootTasksOf(eagerResult.plugins), ...appCodeTask],
        {
        holdOnBlocking: true,
        onProblem: reportBootProblem,
          onChange: (tasks) => {
            if (cancelled) return;
            setState((prev) =>
              prev.phase === "boot-tasks" ? { ...prev, tasks } : prev,
            );
          },
        },
      );
      if (!cancelled) {
        setState({
          phase: "boot-tasks",
          tasks: bootRun.initial,
          continueAnyway: bootRun.continueAnyway,
        });
      }
      await bootRun.settled;
      endBoot();
      if (cancelled) return;
      // Nothing reads the registry before the first render below (the boot
      // screen mounts no PluginProvider), so these appends notify no one.
      registry.append(eagerResult.plugins);
      // Loaded, unless the user chose Continue anyway first: then the app's
      // content registers when it lands, after the first paint.
      const appCodeAtPaint = appCode.loaded;
      if (appCodeAtPaint !== null) await registerBatch(appCodeAtPaint);
      markBootInstant("set-state", "paint", "App setState (first render)");
      if (cancelled) return;
      // The first render that can show data: the commit that swaps the boot
      // screen for the app, chrome and eager panes reading the hydrated cache.
      // Armed here, not by the snapshot task: the boot screen commits too (its
      // elapsed clock), so "the next commit after hydrate" could be one of its.
      markBootInstantAtNextCommit(
        FIRST_DATA_COMMIT_ID,
        "paint",
        "First commit after boot snapshot",
      );

      // The active app's content is on screen at this first commit — or, past
      // Continue anyway, at the commit that registers it.
      if (appCodeAtPaint !== null) markRouteContentAtNextCommit();
      setState({ phase: "ready", coreErrors: eagerResult.errors });
      rendered = true;
      recordErrors(eagerResult.errors);
      if (appCodeAtPaint === null) {
        const late = await appCodeLoad;
        if (cancelled) return;
        markRouteContentAtNextCommit();
        await registerBatch(late);
      }

      // The rest of the deferred tier, AFTER the first app frame has
      // committed (never competing with it): drained in yielding idle batches.
      await appCommitted.promise;
      for (let i = 0; i < rest.length && !cancelled; i += DEFERRED_BATCH_SIZE) {
        await loadDeferredBatch(rest.slice(i, i + DEFERRED_BATCH_SIZE));
        // Breathe between batches so the queued socket grant + input + paint can
        // interleave instead of being starved by a long evaluation run.
        await yieldToMain();
      }
      if (cancelled) return;
      markBootInstant(
        DEFERRED_LOAD_COMPLETE_ID,
        "scripts",
        "Deferred plugin tier loaded",
      );
      markDeferredLoadComplete();
      // Every plugin has loaded or failed: a companion still absent is one the
      // bundle lacks, and its owner is degrading silently right now.
      for (const message of missingCompanions(registry))
        reportMissingCompanion(message);
    })().catch((err: unknown) => {
      // After the first render the app is on screen and its own crash
      // collector reports an unhandled rejection: leave it to that.
      if (rendered) throw err;
      reportBootCrash(err);
      if (!cancelled) {
        setState({
          phase: "crashed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [registry, appCommitted]);

  if (state.phase === "loading-code")
    return <BootScreen phase="loading-code" />;
  if (state.phase === "crashed")
    return <BootScreen phase="crashed" message={state.message} />;
  if (state.phase === "boot-tasks") {
    return (
      <BootScreen
        phase="boot-tasks"
        tasks={state.tasks}
        onContinue={state.continueAnyway}
      />
    );
  }

  return (
    <>
      {state.coreErrors.length > 0 && (
        <PluginLoadErrors errors={state.coreErrors} />
      )}
      <NotificationsProvider>
        <PluginProvider
          registry={registry}
          composition={composition}
          onDemand={onDemand}
          scopeRoots={<RenderScopeRoot />}
        >
          <RenderCoreRoot />
        </PluginProvider>
      </NotificationsProvider>
    </>
  );
}
