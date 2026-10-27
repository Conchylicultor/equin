import { z } from "zod";
import type { BrowserTab, BrowserTabsState } from "../nav-store";

/**
 * The browser's tab set as it outlives a page: one per browser (every surface
 * showing the Browser app shows these tabs), saved in Web Storage. Only what a
 * remote page cannot tell again before it is attached is kept — the key that
 * names the page on the engine host, what the tab shows, and its title/icon for
 * the strip. Everything about delivering commands (`request`, `sentSeq`,
 * `pendingCloses`) belongs to one surface and is never saved.
 */
export const SavedTabSchema = z.object({
  key: z.string().min(1),
  url: z.string(),
  pageUrl: z.string(),
  title: z.string(),
  faviconUrl: z.string().nullable(),
});
export type SavedTab = z.infer<typeof SavedTabSchema>;

export const SavedTabsSchema = z.object({
  tabs: z.array(SavedTabSchema).min(1).max(500),
  /** The tab last selected anywhere: what a newly mounted surface selects. */
  activeKey: z.string(),
});
export type SavedTabs = z.infer<typeof SavedTabsSchema>;

/** A `data:` icon can weigh kilobytes; the tab re-reports it once attached. */
function savedFavicon(url: string | null): string | null {
  return url !== null && url.startsWith("data:") ? null : url;
}

/** The saved projection of a surface's tabs. */
export function toSaved(state: BrowserTabsState): SavedTabs {
  const active = state.tabs.find((t) => t.id === state.activeId);
  return {
    tabs: state.tabs.map((t) => ({
      key: t.key,
      url: t.url,
      pageUrl: t.pageUrl,
      title: t.title,
      faviconUrl: savedFavicon(t.faviconUrl),
    })),
    activeKey: active?.key ?? "",
  };
}

/**
 * A tab for a saved one this surface does not hold yet. Its remote page was
 * created by an `attach` before (`pageUrl` set) — or, if the host closed it
 * since, the next `attach` recreates it at `url`. What the page reports
 * (history, loading) is unknown until then.
 */
function restoredTab(saved: SavedTab): BrowserTab {
  return {
    id: saved.key,
    key: saved.key,
    url: saved.url,
    pageUrl: saved.pageUrl,
    remote: saved.pageUrl !== "",
    title: saved.title,
    faviconUrl: saved.faviconUrl,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    request: null,
    sentSeq: 0,
  };
}

/** A surface's first state, from the saved tab set. */
export function restoreState(saved: SavedTabs): BrowserTabsState {
  const tabs = saved.tabs.map(restoredTab);
  const active = tabs.find((t) => t.key === saved.activeKey) ?? tabs[0];
  if (!active) throw new Error("SavedTabsSchema admits no empty tab set");
  return { tabs, activeId: active.id, seq: 1, pendingCloses: [] };
}

/**
 * Fold a tab set another surface saved into this one, by key: a tab both hold
 * keeps this surface's delivery state and takes the saved fields; a new one is
 * added; one missing was closed there (whoever closed it queued its host close)
 * and goes. This surface keeps its own selection while it still exists — else
 * the tab that took its place.
 */
export function mergeSaved(
  state: BrowserTabsState,
  saved: SavedTabs,
): BrowserTabsState {
  const mine = new Map(state.tabs.map((t) => [t.key, t]));
  const tabs = saved.tabs.map((s): BrowserTab => {
    const t = mine.get(s.key);
    if (!t) return restoredTab(s);
    return {
      ...t,
      url: s.url,
      pageUrl: s.pageUrl,
      title: s.title,
      // A `data:` icon is never saved: keep the one this surface was told.
      faviconUrl: s.faviconUrl ?? t.faviconUrl,
    };
  });
  let { activeId } = state;
  if (!tabs.some((t) => t.id === activeId)) {
    const idx = state.tabs.findIndex((t) => t.id === activeId);
    const next = tabs[Math.min(Math.max(idx, 0), tabs.length - 1)];
    if (!next) throw new Error("SavedTabsSchema admits no empty tab set");
    activeId = next.id;
  }
  return { ...state, tabs, activeId };
}
