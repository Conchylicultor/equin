import { useContext, useEffect } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import {
  PaneSurfaceProvider,
  PaneBasePathContext,
  useRoute,
  useRouteState,
  useIndexMatch,
  usePaneTitle,
} from "@plugins/primitives/plugins/pane/web";
import {
  SyncStatusProvider,
  SyncStatusIndicator,
} from "@plugins/primitives/plugins/sync-status/web";
import { SurfaceOverlayHost } from "@plugins/primitives/plugins/overlay/plugins/surface-overlay/web";
import {
  UndoRedoProvider,
  useUndoRedoShortcuts,
} from "@plugins/primitives/plugins/undo-redo/web";
import { Apps } from "@plugins/apps-core/web";
import {
  appPathFor,
  loadScopePrefixFor,
  useTabs,
  type Tab,
} from "@plugins/apps-core/plugins/tabs/web";

/**
 * The per-tab render core, shared by every surface arrangement. Mounts the tab's
 * own `PaneSurfaceProvider` (its store + base path), reports its leaf title up to
 * the tabs store, and renders the app surface. Identical for the tabs and desktop
 * arrangements, so both reuse this — keeping the `PaneSurfaceProvider` mounting
 * byte-identical regardless of how the tab is laid out on screen.
 *
 * It is also where the tab's surface-scoped primitives are mounted — one
 * `<SyncStatusProvider>` and one `<UndoRedoProvider>` per tab. The undo history
 * is a platform capability every plugin in the tab records into (a sidebar row's
 * delete and an edit in the page body land on ONE chronological stack), so it
 * cannot belong to any one pane or editor; and the `mod+z` bindings must be
 * registered exactly once per surface, or two same-id registrations would race
 * in the page-global `ShortcutManager`.
 */
export function TabSurface({ tab }: { tab: Tab }) {
  const apps = Apps.App.useContributions();
  const app = apps.find((a) => a.id === tab.appId);
  if (!app) return null;
  return (
    <PaneSurfaceProvider
      store={tab.store}
      basePath={appPathFor(tab.appId, apps)}
      appId={tab.appId}
      surfaceId={tab.tabId}
      loadScopePrefix={loadScopePrefixFor(app._pluginId)}
    >
      <TabTitleReporter tabId={tab.tabId} />
      <SyncStatusProvider>
        <UndoRedoProvider>
          <UndoRedoKeys />
          {/* Owns the surface's outer box — `relative` so the indicator's Pin
              anchors to this surface's corner, `size-full` so the app render
              still fills it. It is also every surface's overlay host, so a pane
              can fill its own tab (leaving the tab bar and rail on screen)
              instead of escaping to the viewport — and because the host sits
              INSIDE whatever box the placement hands the tab, that overlay
              lands correctly under docked, floating-window and solo alike. */}
          <SurfaceOverlayHost>
            {renderIsolated(Apps.App, app as unknown as Contribution)}
            <SyncStatusIndicator />
          </SurfaceOverlayHost>
        </UndoRedoProvider>
      </SyncStatusProvider>
    </PaneSurfaceProvider>
  );
}

/**
 * The tab's `mod+z` / `mod+shift+z` / `mod+y` bindings. Its own component only
 * because the hook must run INSIDE the `<UndoRedoProvider>` mounted in the same
 * JSX above. An app that records nothing keeps an empty stack, so `canUndo` is
 * false, the shortcut's `when` guard rejects, and the keys are never claimed.
 * The guard also yields to any text field keeping its own undo history, so this
 * one binding never reaches across the tab into an editor the user isn't in
 * (see `primitives/undo-redo`'s `resolveUndoOwner`).
 */
function UndoRedoKeys() {
  useUndoRedoShortcuts();
  return null;
}

/**
 * Reads the tab's title-owning pane and publishes its resolved title up to the
 * tabs store, so the tab bar and the browser title can show the selected
 * page/conversation/song. The title owner is the FIRST pane in the route
 * declaring `titleOwner` (the main surface — a conversation, a task), so
 * auxiliary panes stacked to its right (file peek, review, terminal) never
 * steal the title; routes with no owner fall back to the leaf. Mounted inside
 * each tab's `PaneSurfaceProvider`, so `useRoute()` reads THIS tab's store —
 * including background (keep-alive) tabs, which keep their label fresh while
 * unfocused. The actual `useTitle` hook runs one level down in
 * {@link LeafTitleReporter}, keyed by pane id.
 */
function TabTitleReporter({ tabId }: { tabId: string }) {
  const route = useRoute();
  const state = useRouteState();
  const panes = route?.panes ?? [];
  const leaf =
    panes.find((p) => p.pane.titleOwner) ??
    (panes.length > 0 ? panes[panes.length - 1]! : null);
  // A companion leading the route sits beside the index pane (see
  // `PaneInternal.companion`), so the page is still the index's: a file
  // previewed from the home keeps the tab titled "Home".
  if (leaf && !leaf.pane.titleOwner && panes[0]?.pane.companion) {
    return <IndexTitleReporter key="index" tabId={tabId} />;
  }
  if (leaf) {
    return (
      <LeafTitleReporter
        key={leaf.pane.id}
        tabId={tabId}
        pane={leaf.pane}
        params={leaf.fullParams}
        hint={leaf.hint}
        options={leaf.options}
      />
    );
  }
  // Index title ONLY at a GENUINE bare app root (resolved with zero slots).
  // Anything else that renders no leaf — a pending / not-found URL (unresolved)
  // or a resolved route whose slots don't resolve yet (unresolvable paneIds) —
  // clears the title so the tab bar shows the app name, never a homepage-title
  // misreport during the load gap.
  if (state.kind === "resolved" && state.slots.length === 0) {
    return <IndexTitleReporter key="index" tabId={tabId} />;
  }
  return <TitleClear key="clear" tabId={tabId} />;
}

/**
 * Empty-route fallback: resolves the tab app's index pane (the one declaring
 * `appIndex` for this app) via {@link useIndexMatch} and publishes its title
 * through the same {@link LeafTitleReporter}/`usePaneTitle` path. This is what
 * lets two same-app index tabs show their index pane's title instead of the bare
 * app name. The base path is read from `PaneBasePathContext`, which this tab's
 * `PaneSurfaceProvider` already provides. Index panes without a configured
 * title clear it, so the tab bar still falls back to the app name.
 */
function IndexTitleReporter({ tabId }: { tabId: string }) {
  const basePath = useContext(PaneBasePathContext);
  const entry = useIndexMatch(basePath)?.panes[0] ?? null;
  return entry ? (
    <LeafTitleReporter
      key={entry.pane.id}
      tabId={tabId}
      pane={entry.pane}
      params={entry.fullParams}
      hint={entry.hint}
      options={entry.options}
    />
  ) : (
    <TitleClear tabId={tabId} />
  );
}

/**
 * Resolves and publishes one pane's title. Separate from {@link TabTitleReporter}
 * and keyed by pane id there, so the pane-specific `useTitle` hook (via
 * `usePaneTitle`) mounts/unmounts as a unit when the leaf pane changes — keeping
 * hook order stable across pane switches.
 */
function LeafTitleReporter({
  tabId,
  pane,
  params,
  hint,
  options,
}: {
  tabId: string;
  pane: Parameters<typeof usePaneTitle>[0];
  params: Record<string, string>;
  hint: Parameters<typeof usePaneTitle>[2];
  options: Parameters<typeof usePaneTitle>[3];
}) {
  const { setTabTitle } = useTabs();
  const title = usePaneTitle(pane, params, hint, options);
  useEffect(() => {
    setTabTitle(tabId, title);
  }, [tabId, title, setTabTitle]);
  return null;
}

/** Clears a tab's title when its route is empty (app index / no leaf pane). */
function TitleClear({ tabId }: { tabId: string }) {
  const { setTabTitle } = useTabs();
  useEffect(() => {
    setTabTitle(tabId, undefined);
  }, [tabId, setTabTitle]);
  return null;
}
