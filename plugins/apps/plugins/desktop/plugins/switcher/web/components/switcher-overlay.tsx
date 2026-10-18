import { useCallback, useEffect, useState } from "react";
import { Apps } from "@plugins/apps-core/web";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  bringWindowToFront,
  restoreWindow,
  useDesktops,
  useFloatingWindows,
  type WindowId,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { switcherControlsSink } from "../internal/switcher-controls";
import {
  MIN_SWITCHER_WINDOWS,
  stepIndex,
  switcherOrder,
} from "../internal/switcher-model";
import { SwitcherThumb } from "./switcher-thumb";

/** An open switcher: the windows it lists (front-most first) and the selected one. */
interface Session {
  ids: WindowId[];
  index: number;
}

/**
 * The window switcher (mockup `#switcher`): a panel of snapshots of the active
 * desktop's windows, front-most first, with the selected window's
 * "App — title" under it. The first press of the shortcut opens it, each press
 * steps the selection, and RELEASING the modifier commits — the selected window
 * is restored if minimised and brought forward. Esc, or the window losing
 * focus, cancels; clicking a snapshot commits that one.
 */
export function SwitcherOverlay() {
  const windows = useFloatingWindows();
  const { activeDesktopId } = useDesktops();
  const { tabs, titles, focusTab } = useTabs();
  const [session, setSession] = useState<Session | null>(null);
  const latest = useLatestRef({ windows, activeDesktopId, session, focusTab });

  useEffect(
    () =>
      switcherControlsSink.install({
        step(delta) {
          setSession((prev) => {
            if (prev) {
              return {
                ids: prev.ids,
                index: stepIndex(prev.index, delta, prev.ids.length),
              };
            }
            const { windows, activeDesktopId } = latest.current;
            const ids = switcherOrder(windows.values(), activeDesktopId).map(
              (w) => w.id,
            );
            if (ids.length < MIN_SWITCHER_WINDOWS) return null;
            return { ids, index: stepIndex(0, delta, ids.length) };
          });
        },
      }),
    [latest],
  );

  // Commit `id` (default: the selected window): close, then restore it if
  // minimised, bring it forward and focus it. Reads everything through `latest`,
  // so it is stable and a stale closure cannot commit the wrong window.
  const commit = useCallback(
    (id?: WindowId) => {
      const { windows, session, focusTab } = latest.current;
      setSession(null);
      if (!session) return;
      const w = windows.get(id ?? session.ids[session.index]!);
      if (!w) return;
      if (w.geo.minimized) restoreWindow(w.id);
      bringWindowToFront(w.id);
      focusTab(w.activeTabId);
    },
    [latest],
  );

  const open = session !== null;
  useEffect(() => {
    if (!open) return;
    // The switcher owns the keyboard while it is on screen: the modifier's
    // RELEASE commits, which the shortcut registry (keydown only) cannot see, and
    // Esc cancels ahead of every other Esc binding (capture + stop). Both are
    // this page's one switcher, not a per-surface key.
    function onKeyUp(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) commit();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setSession(null);
    }
    const cancel = () => setSession(null);
    // eslint-disable-next-line shortcuts/no-window-key-listener -- transient mode that owns the keyboard: the modifier's release commits (keyup, which the registry has no spelling for)
    window.addEventListener("keyup", onKeyUp);
    // eslint-disable-next-line shortcuts/no-window-key-listener -- transient mode that owns the keyboard: Esc cancels before any other Esc binding hears it
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
    };
  }, [open, commit]);

  const apps = Apps.App.useContributions();
  if (!session) return null;

  const rows = session.ids.flatMap((id) => {
    const w = windows.get(id);
    if (!w) return [];
    const appId = tabs.find((t) => t.tabId === w.activeTabId)?.appId;
    const app = apps.find((a) => a.id === appId);
    return app ? [{ window: w, app }] : [];
  });
  const selected = rows[session.index];
  const title = selected ? titles[selected.window.activeTabId] : undefined;

  return (
    <Layer layer="overlay" decorative>
      <Stack
        gap="md"
        align="center"
        justify="center"
        className="size-full p-lg"
      >
        <Surface
          level="overlay"
          className={cn(
            "pointer-events-auto max-w-[min(1100px,100%)] rounded-2xl p-sm",
            // The mockup's lift; no shadow token carries this much spread.
            "shadow-[0_30px_80px_-20px_rgba(0,0,0,0.5)]",
            "animate-in fade-in-0 zoom-in-97 slide-in-from-top-1.5 duration-150 ease-out",
          )}
        >
          <Cluster gap="xs" justify="center" align="start">
            {rows.map(({ window: w, app }, i) => (
              <SwitcherThumb
                key={w.id}
                window={w}
                app={app}
                title={titles[w.activeTabId]}
                tabCount={w.members.length}
                selected={i === session.index}
                onPick={() => commit(w.id)}
              />
            ))}
          </Cluster>
        </Surface>
        {selected && (
          <Text
            variant="label"
            // The mockup's dark glass pill: the desktop theme's ink as a scrim.
            className="rounded-full bg-foreground/65 px-md py-xs text-background backdrop-blur-md"
          >
            {title
              ? `${selected.app.app.name} — ${title}`
              : selected.app.app.name}
          </Text>
        )}
      </Stack>
    </Layer>
  );
}
