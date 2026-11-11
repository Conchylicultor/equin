import type { ReactNode } from "react";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core";
import {
  loadPlugins,
  PluginProvider,
  type CompositionIdentity,
  type LoadedPlugin,
  type PluginEntry,
} from "@plugins/framework/plugins/web-sdk/core";
import { TransportProvider } from "@plugins/primitives/plugins/networking/web";
import {
  ensureNotificationsClient,
  NotificationsProvider,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  hydrateBootSnapshot,
  type BootSnapshotValues,
} from "@plugins/network/plugins/live/plugins/boot-snapshot/web";
import {
  createPaneStore,
  Pane,
  PaneSurfaceProvider,
  stripBasePath,
  usePaneMatch,
  usePaneTitle,
  type AnyPane,
  type MatchEntry,
} from "@plugins/primitives/plugins/pane/web";
import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import {
  createStaticTransport,
  type StaticRenderNetworkError,
} from "./static-transport";

/** A static render failed: names the pane, the path and the component path. */
export class StaticRenderError extends Error {
  constructor(
    readonly pane: string,
    readonly path: string,
    reason: string,
    readonly componentStack: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(
      `[static-render] pane "${pane}" at ${path}: ${reason}` +
        (componentStack ? `\n  component path:${componentStack}` : ""),
      options,
    );
    this.name = "StaticRenderError";
  }
}

/** One rendered pane. */
export interface StaticPage {
  /** The pane's markup as the app draws it (react-dom's static prerender). */
  html: string;
  /** The pane's own title (`Pane.define({ title })`), `undefined` when it declares none. */
  title: string | undefined;
  /** The pane the path resolved to (its id). */
  paneId: string;
  /** The app the path belongs to: its id and display name (`AppRef`). */
  app: { id: string; name: string };
}

export interface StaticRenderer {
  /**
   * Render the pane `path` resolves to, in the app whose base path holds it
   * (the longest registered one). `pane`, when given, is the one the caller
   * means: the render throws when `path` resolves to another. Without it the
   * path alone decides — and resolving to no pane still throws.
   */
  render(page: { path: string; pane?: AnyPane }): Promise<StaticPage>;
  /**
   * Boot-snapshot keys no loaded plugin declares a descriptor for. Empty when
   * the snapshot was taken from the same composition; the caller decides
   * whether extra keys are an error.
   */
  readonly unhydrated: readonly string[];
  /**
   * The composition's home app (`CompositionIdentity.home`, the app bare `/`
   * goes to) as the registered panes know it — its id, name and base path —
   * or `null` for a composition with no home. A home no registered pane
   * belongs to throws at creation.
   */
  readonly home: { id: string; name: string; basePath: string } | null;
  /**
   * Every registered app's former base paths (`AppRef.formerBasePaths`), each
   * mapped to the app's base path: where a request under an old address goes.
   * Empty when no app ever moved.
   */
  readonly moved: Readonly<Record<string, string>>;
}

let created = false;

/**
 * Make this process a static render of one composition, ready to render its
 * panes to HTML that is never hydrated (robots read it).
 *
 * In order, so none can be done out of turn:
 * 1. declares the process's render mode `"static"` (`dom/render-mode`) — before
 *    any plugin loads, so a building block writes into its markup what a click
 *    would compute (a link's `data-link`, a closed fold's content);
 * 2. loads `entries` through the web loader (`loadPlugins`) — any load error
 *    throws;
 * 3. builds the page's live-state pipeline over a transport with no server
 *    behind it (a request or socket fails the render), and hydrates
 *    `bootSnapshot` through the boot task's own hydrate path — a value its
 *    schema rejects throws.
 *
 * Once per process: the render mode and the page's live-state pipeline are
 * both process-wide.
 */
export async function createStaticRenderer(opts: {
  entries: PluginEntry[];
  composition: CompositionIdentity;
  bootSnapshot: BootSnapshotValues;
}): Promise<StaticRenderer> {
  if (created) {
    throw new Error(
      "[static-render] createStaticRenderer called twice — a process is one static render (its render mode and live-state pipeline are process-wide).",
    );
  }
  created = true;
  declareRenderMode("static");

  const { plugins, errors } = await loadPlugins(opts.entries);
  if (errors.length > 0) {
    throw new Error(
      `[static-render] ${errors.length} plugin(s) failed to load: ${errors
        .map(
          (e) =>
            `${e.pluginPath}: ${e.error instanceof Error ? e.error.message : String(e.error)}`,
        )
        .join("; ")}`,
      { cause: errors[0]!.error },
    );
  }

  const violations: StaticRenderNetworkError[] = [];
  const transport = createStaticTransport((e) => violations.push(e));
  // The page's pipeline — the one owning the default query cache that
  // `hydrateResource` seeds — bound to this transport.
  ensureNotificationsClient(transport);
  const { missing, failed } = hydrateBootSnapshot(opts.bootSnapshot);
  if (failed.length > 0) {
    throw new Error(
      `[static-render] boot snapshot: ${failed.length} value(s) failed to hydrate: ${failed.join("; ")}`,
    );
  }

  // Every app a registered pane belongs to, by base path: what a bare path is
  // resolved against.
  const apps = new Map<string, AnyPane["_internal"]["app"]>();
  for (const plugin of plugins) {
    for (const c of plugin.contributions ?? []) {
      if (c._slot !== Pane.Register) continue;
      const app = (c as unknown as { pane: AnyPane }).pane._internal.app;
      apps.set(app.basePath, app);
    }
  }
  const appOf = (path: string) => {
    const owner = [...apps.values()]
      .filter(
        (a) => stripBasePath(path, a.basePath) !== path || path === a.basePath,
      )
      .sort((a, b) => b.basePath.length - a.basePath.length)[0];
    if (owner === undefined) {
      throw new StaticRenderError(
        "(none)",
        path,
        `no registered pane's app has a base path holding it (apps: ${[...apps.keys()].sort().join(", ") || "none"})`,
        undefined,
      );
    }
    return owner;
  };

  let home: StaticRenderer["home"] = null;
  if (opts.composition.home !== null) {
    const app = [...apps.values()].find((a) => a.id === opts.composition.home);
    if (app === undefined) {
      throw new Error(
        `[static-render] the composition's home app "${opts.composition.home}" has no registered pane (apps: ${
          [...apps.values()]
            .map((a) => a.id)
            .sort()
            .join(", ") || "none"
        })`,
      );
    }
    home = { id: app.id, name: app.name, basePath: app.basePath };
  }

  const moved: Record<string, string> = {};
  for (const app of apps.values()) {
    for (const former of app.formerBasePaths ?? [])
      moved[former] = app.basePath;
  }

  return {
    unhydrated: missing,
    home,
    moved,
    // Async, so an unresolvable path rejects like every other failure.
    render: async (page) =>
      renderPage({
        path: page.path,
        expected: page.pane,
        app: page.pane?._internal.app ?? appOf(page.path),
        plugins,
        composition: opts.composition,
        transport,
        violations,
      }),
  };
}

async function renderPage(args: {
  path: string;
  expected: AnyPane | undefined;
  app: AnyPane["_internal"]["app"];
  plugins: LoadedPlugin[];
  composition: CompositionIdentity;
  transport: ReturnType<typeof createStaticTransport>;
  violations: StaticRenderNetworkError[];
}): Promise<StaticPage> {
  const { path, app } = args;
  // Named by the pane the caller means, else by the one the path resolved to
  // once known (a failure before that names the path's app).
  let paneName = args.expected?.id ?? `(${app.id})`;
  const fail = (reason: string, stack?: string, cause?: unknown) =>
    new StaticRenderError(paneName, path, reason, stack, { cause });

  const appPath = stripBasePath(path, app.basePath);
  if (appPath === path && path !== app.basePath) {
    throw fail(`the path is not under its app's base path ${app.basePath}`);
  }
  // A background store: it writes no history and resolves its seeded path
  // against the pane registry once the surface has synced it (during render).
  const store = createPaneStore({ live: false });
  store.seedPending(appPath.replace(/^\/+/, ""));

  // A one-shot render: the pane hands out what it read through `report`.
  let rendered: { title: string | undefined; paneId: string } | undefined;
  const report = (paneId: string, title: string | undefined) => {
    paneName = paneId;
    rendered = { title, paneId };
  };
  const violationsBefore = args.violations.length;
  const tree = (
    <TransportProvider transport={args.transport}>
      <NotificationsProvider>
        <PluginProvider plugins={args.plugins} composition={args.composition}>
          <PaneSurfaceProvider
            store={store}
            basePath={app.basePath}
            appId={app.id}
          >
            <StaticPane expected={args.expected} report={report} />
          </PaneSurfaceProvider>
        </PluginProvider>
      </NotificationsProvider>
    </TransportProvider>
  );

  const errors: { error: unknown; componentStack: string | undefined }[] = [];
  const { prerender } = await import("react-dom/static");
  let html: string;
  try {
    const { prelude } = await prerender(tree, {
      onError(error, info) {
        errors.push({ error, componentStack: info.componentStack });
      },
    });
    html = await new Response(prelude).text();
  } catch (err) {
    const first = errors[0];
    throw fail(
      messageOf(first?.error ?? err),
      first?.componentStack,
      first?.error ?? err,
    );
  }
  // An error inside a Suspense boundary does not reject the prerender: the
  // boundary renders its fallback, which is not the page.
  const first = errors[0];
  if (first)
    throw fail(messageOf(first.error), first.componentStack, first.error);
  const violation = args.violations[violationsBefore];
  if (violation) throw fail(violation.message, undefined, violation);
  if (rendered === undefined) throw fail("the pane did not render");
  return {
    html,
    title: rendered.title,
    paneId: rendered.paneId,
    app: { id: app.id, name: app.name },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The surface's body: the pane the path resolved to, painted by the real
 * full-surface layout renderer — after checking it is the expected one, so a
 * stale path or an unregistered pane fails instead of rendering a fallback.
 */
function StaticPane({
  expected,
  report,
}: {
  expected: AnyPane | undefined;
  report: (paneId: string, title: string | undefined) => void;
}): ReactNode {
  const active = usePaneMatch()?.panes.at(-1);
  if (!active) {
    throw new Error(
      "the path resolves to no registered pane (is the pane's plugin in the composition, and its Pane.Register contributed?)",
    );
  }
  if (expected !== undefined && active.pane.id !== expected.id) {
    throw new Error(
      `the path resolves to pane "${active.pane.id}", not "${expected.id}"`,
    );
  }
  return <StaticPaneBody entry={active} report={report} />;
}

function StaticPaneBody({
  entry,
  report,
}: {
  entry: MatchEntry;
  report: (paneId: string, title: string | undefined) => void;
}): ReactNode {
  report(
    entry.pane.id,
    usePaneTitle(entry.pane, entry.fullParams, entry.hint, entry.options),
  );
  return <FullPane />;
}
