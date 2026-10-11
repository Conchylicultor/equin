import { useState, useEffect } from "react";
import {
  PluginProvider,
  Core,
  loadPlugins,
  partitionWebEntries,
  markDeferredPluginsLoaded,
  markDeferredLoadComplete,
  markDeferredPluginsFailed,
  pluginLoadReportSink,
  UNSAFE_unsealSlotComponent,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  LoadedPlugin,
  PluginLoadError,
} from "@plugins/framework/plugins/web-sdk/core";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { normalizeRoutePath } from "@plugins/primitives/plugins/pane/core";
import {
  NotificationsProvider,
  ensureNotificationsClient,
} from "@plugins/primitives/plugins/live-state/web";
import { yieldToMain } from "@plugins/primitives/plugins/perfs/plugins/scheduler/web";
import {
  startBootSpan,
  markBootInstant,
  markBootInstantAtNextCommit,
  traceBootPluginLoad,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import {
  DEFERRED_LOAD_COMPLETE_ID,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import type { BootPluginLoadDetail } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import { webEntries } from "@composition-web-registry";
import { PluginLoadErrors } from "./components/plugin-load-errors";

// The concrete registry-entry type (`{ pluginPath, id, loader, dependsOn }`) —
// carries the non-optional `id` we need to map a loaded plugin back to its path.
type WebEntry = (typeof webEntries)[number];

// Deferred plugin chunks evaluated per batch before yielding the main thread.
// Small enough that one batch never monopolizes the thread (so the queued
// leader-election socket grant + paint can interleave), large enough that the
// whole deferred tier still drains quickly.
const DEFERRED_BATCH_SIZE = 24;

// Run every Core.Boot readiness task once, before the plugins register, so they
// can hydrate caches the initial render depends on (e.g. config — replacing
// per-component Suspense). Enumerated from the raw contributions because
// PluginProvider (and useContributions) isn't mounted yet. A failing or hung
// task must never brick boot: allSettled + log, then proceed regardless — reads
// degrade to their own fallbacks and self-heal via the WS shortly after.
async function runBootTasks(plugins: LoadedPlugin[]): Promise<void> {
  const tasks = plugins.flatMap((p) =>
    (p.contributions ?? []).filter((c) => c._slot === Core.Boot),
  );
  if (tasks.length === 0) return;
  const results = await Promise.allSettled(
    tasks.map((t) => (t as unknown as { run: () => Promise<void> }).run()),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[boot] Core.Boot task failed", r.reason);
    }
  }
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
      }
    }
  }
  // Longest-path-prefix match against the URL — inlined rather than reusing
  // apps-core's matchAppForPath, whose `ActiveApp` param is the *sealed*
  // contribution shape (its `component` is opaque), which fights our raw
  // unsealed contributions. The match logic is identical (see resolve-app.ts).
  // eslint-disable-next-line pane/no-raw-location-path -- pre-boot: `currentRoutePath()` lives in pane/web, which this eager boot root must not pull in; the pure core normalizer is the same canonicalization.
  const pathname = normalizeRoutePath(window.location.pathname);
  const matched = [...apps]
    .sort((a, b) => b.path.length - a.path.length)
    .find((a) => pathname === a.path || pathname.startsWith(a.path + "/"));
  if (!matched) return null;
  // The matched contribution's pluginPath is the app's shell dir
  // (apps/plugins/<app>/plugins/shell); the app root prefix is
  // apps/plugins/<app>/ — all its deferred content lives under it.
  const m = /^(apps\/plugins\/[^/]+)\//.exec(matched.pluginPath);
  return m ? m[1] + "/" : null;
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

function RootRenderer() {
  const roots = Core.Root.useContributions();
  return (
    <>
      {roots.map((r, i) => {
        // UNSAFE: Core.Root is framework bootstrap; web-sdk/core can't import
        // slot-render; isolation is the manual PluginErrorBoundary here.
        const RootComponent = UNSAFE_unsealSlotComponent(r.component);
        return (
          <PluginErrorBoundary key={i} slot="core.root">
            <RootComponent />
          </PluginErrorBoundary>
        );
      })}
    </>
  );
}

interface LoadedState {
  plugins: LoadedPlugin[];
  // Core-stage (eager) load errors ONLY — set once from the eager result and
  // never appended. Those broke something that painted before the user could do
  // anything, so they get the explicit banner. A deferred failure never lands
  // here: it is published by `recordErrors` alone, where the Build button's
  // Reload chip and the app's own "Couldn't load" pane pick it up.
  coreErrors: PluginLoadError[];
}

export default function App() {
  const [state, setState] = useState<LoadedState | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Append a freshly-loaded batch to the live state with a NEW array reference
    // so PluginProvider's useMemo re-derives and registers only the newcomers
    // (runRegisterPhase is idempotent via its `registered` WeakSet), then publish
    // the loaded ids on the deferred-load signal for the layout host. Takes no
    // errors on purpose: a deferred batch's failures have no way into the
    // banner's state.
    const appendPlugins = (plugins: LoadedPlugin[]) => {
      setState((prev) =>
        prev
          ? { ...prev, plugins: [...prev.plugins, ...plugins] }
          : { plugins, coreErrors: [] },
      );
      markDeferredPluginsLoaded(plugins.map((p) => p.id));
    };

    // The active app's content is on screen at the commit that appends its
    // priority batch — or at the first render, when it has none.
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

    const loadDeferredBatch = async (
      batch: WebEntry[],
      { routeContent = false } = {},
    ): Promise<void> => {
      if (batch.length === 0) return;
      // Partial failure is tolerable (loadPlugins uses allSettled + collects
      // errors), so a broken app-content chunk never aborts the tier.
      const { plugins, errors } = await loadPlugins(
        traced(batch, routeContent ? "priority" : "deferred"),
      );
      if (cancelled) return;
      // Run any Core.Boot tasks these plugins contribute (none under apps/ today,
      // but correct + future-proof) before they register, mirroring the eager
      // path so hydration lands before the slot re-render.
      await runBootTasks(plugins);
      if (cancelled) return;
      if (routeContent) markRouteContentAtNextCommit();
      appendPlugins(plugins);
      recordErrors(errors);
    };

    void (async () => {
      // Layer 1 — Transport hoist. Construct the notifications singleton NOW,
      // before any plugin evaluation, so its leader-election lock request is
      // queued at t≈0 and the socket opens during a loadPlugins await gap instead
      // of ~8s later. NotificationsProvider reuses this same singleton.
      ensureNotificationsClient();

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
      const endBoot = startBootSpan(
        "boot-tasks",
        "boot-tasks",
        "runBootTasks (eager)",
      );
      await runBootTasks(eagerResult.plugins);
      endBoot();
      markBootInstant("set-state", "paint", "App setState (first render)");
      if (cancelled) return;

      // Layer 3 — deferred tier, AFTER first paint (never blocks chrome).
      // Active-app-first: front-load the deep-linked app's content as one awaited
      // priority batch, then drain the rest in yielding idle batches.
      const activePrefix = resolveActiveAppPrefix(eagerResult.plugins, eager);
      const priority: WebEntry[] = [];
      const rest: WebEntry[] = [];
      for (const e of deferred) {
        if (activePrefix && e.pluginPath.startsWith(activePrefix))
          priority.push(e);
        else rest.push(e);
      }

      if (priority.length === 0) markRouteContentAtNextCommit();
      setState({
        plugins: eagerResult.plugins,
        coreErrors: eagerResult.errors,
      });
      recordErrors(eagerResult.errors);

      await loadDeferredBatch(priority, { routeContent: true });
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
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) return null;

  return (
    <>
      {state.coreErrors.length > 0 && (
        <PluginLoadErrors errors={state.coreErrors} />
      )}
      <NotificationsProvider>
        <PluginProvider plugins={state.plugins}>
          <RootRenderer />
        </PluginProvider>
      </NotificationsProvider>
    </>
  );
}
