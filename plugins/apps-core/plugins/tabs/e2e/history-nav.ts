// Verifies shell-level history snapshots: browser Back/Forward across apps and
// tabs (research/2026-07-18-global-shell-history-snapshots.md).
//
// Usage:
//   ./equin run plugins/apps-core/plugins/tabs/e2e/history-nav.ts [--url http://<worktree>.localhost:9000] [--out /tmp/histnav]
//
// Scenarios (PASS/FAIL logged per assertion, exit 1 on any failure):
//   A. /story → rail-click Settings → Back returns to /story; Forward → Settings.
//   B. /agents deep link → Settings → Back restores the exact deep link, with
//      history.state carrying {tabId, appId}; reload mints no phantom tab.
//   C. New tab (+) → Back refocuses the previous tab.
//   D. Reload mid-history: /story → Settings → reload → Back still → /story.
//   E. App instances (research/2026-07-24-global-app-instance-boundary.md):
//      a bookmark-style cross-document navigation MINTS a fresh instance (one
//      tab from the URL, default surface mode, no window geometry), a reload
//      preserves it, and Back restores the previous instance in FULL.

import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/histnav");

const r = report();

const pathname = (page: Page): string => new URL(page.url()).pathname;

/** Wait until the SPA has painted something meaningful (rail buttons exist). */
async function settle(page: Page, ms = 800): Promise<void> {
  await page.locator("button.size-8").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(ms);
}

/** Click a rail app icon by its accessible name (aria-label = app tooltip). */
async function clickRailApp(page: Page, appName: string): Promise<boolean> {
  const btn = page.getByRole("button", { name: appName, exact: true }).first();
  try {
    await btn.waitFor({ timeout: 5000 });
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- pre-move behavior: "the rail button never appeared" IS the answer here; the caller asserts on the returned false.
  } catch {
    return false;
  }
  await btn.click();
  await page.waitForTimeout(600);
  return true;
}

/** The shape the tabs plugin persists under its `app-tabs:` sessionStorage key. */
interface PersistedTabState {
  tabs: { tabId?: string; appId?: string }[];
  focusedTabId?: string;
  mode?: string;
}

/** The shell's own history-entry snapshot. */
interface HistoryEntryState {
  tabId?: string;
  appId?: string;
  appInstance?: string;
}

// The storage grammar below is `primitives/scope/app-instance`'s, spelled out as
// literals because this runs INSIDE the page (an e2e script may import only
// `core`/`e2e` barrels, never `web`). Keys are
// `<prefix>:<tabId>:<generation>`; `singularity.appInstances:<tabId>` holds the
// LRU generation list with the active one last.
const TAB_ID_KEY = "singularity.tabId";
const REGISTRY_PREFIX = "singularity.appInstances:";

/**
 * The app instance this document is running as: the generation stamped on the
 * current history entry, falling back to the registry's last-active entry (an
 * entry written before the stamp existed, or one the canonicalization redirect
 * touched). Named explicitly rather than "the first `app-tabs:` key", which now
 * matches an ARBITRARY generation.
 */
function currentInstance(
  page: Page,
): Promise<{ tabId: string; gen: string } | null> {
  return page.evaluate(
    ([tabIdKey, registryPrefix]) => {
      try {
        const tabId = sessionStorage.getItem(tabIdKey!);
        if (!tabId) return null;
        const entry = window.history.state as { appInstance?: string } | null;
        let gen = entry?.appInstance;
        if (!gen) {
          const raw = sessionStorage.getItem(registryPrefix! + tabId);
          const list = raw ? (JSON.parse(raw) as string[]) : [];
          gen = list.at(-1);
        }
        return gen ? { tabId, gen } : null;
        // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- pre-move behavior: a non-app document has no readable instance, and every assertion below treats null as exactly that.
      } catch {
        return null; // non-app document (e.g. about:blank after a bad Back)
      }
    },
    [TAB_ID_KEY, REGISTRY_PREFIX],
  );
}

/** The persisted in-app tab set for the instance this document is running as. */
async function persistedTabs(page: Page): Promise<PersistedTabState | null> {
  const instance = await currentInstance(page);
  if (!instance) return null;
  return page.evaluate((key) => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? (JSON.parse(raw) as PersistedTabState) : null;
      // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- pre-move behavior: a non-app document has no readable tab state, and every assertion below treats null as exactly that.
    } catch {
      return null; // non-app document (e.g. about:blank after a bad Back)
    }
  }, `app-tabs:${instance.tabId}:${instance.gen}`);
}

/** Whether ANY floating-window geometry is persisted for `gen`. */
function hasWindowGeometry(page: Page, gen: string): Promise<boolean> {
  return page.evaluate((suffix) => {
    // Index-walk, never Object.keys(sessionStorage).
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith("app-windows:") && key.endsWith(suffix)) return true;
    }
    return false;
  }, `:${gen}`);
}

const historyState = (page: Page): Promise<HistoryEntryState | null> =>
  page.evaluate(() => window.history.state as HistoryEntryState | null);

await withBrowser(async (h) => {
  // One browsing context for all four scenarios; each scenario runs on its own
  // page (the session's page serves scenario A) and closes it when done.
  const { context, page: pageA } = await h.session();

  // ---- Scenario A: cross-app rail click pushes; Back/Forward traverse it ----
  {
    const page = pageA;
    await page.goto(pathUrl("/story"));
    await settle(page);
    r.ok("A: settled on /story", pathname(page) === "/story", pathname(page));

    const clicked = await clickRailApp(page, "Settings");
    r.ok(
      "A: rail-clicked Settings",
      clicked && pathname(page).startsWith("/settings"),
      pathname(page),
    );
    const state = await historyState(page);
    r.ok(
      "A: entry carries appId",
      state?.appId === "settings",
      JSON.stringify(state)?.slice(0, 120),
    );

    await page.goBack();
    await page.waitForTimeout(800);
    r.ok(
      "A: Back returns to /story",
      pathname(page) === "/story",
      pathname(page),
    );
    await snap(page, out, "A-back");

    await page.goForward();
    await page.waitForTimeout(800);
    r.ok(
      "A: Forward returns to Settings",
      pathname(page).startsWith("/settings"),
      pathname(page),
    );
    await page.close();
  }

  // ---- Scenario B: deep link → Settings → Back restores the EXACT deep link ----
  {
    const deep = "/agents/c/conv-1784325578-uxps";
    const page = await context.newPage();
    await page.goto(pathUrl(deep));
    await settle(page);
    r.ok("B: settled on deep link", pathname(page) === deep, pathname(page));

    const clicked = await clickRailApp(page, "Settings");
    r.ok(
      "B: rail-clicked Settings",
      clicked && pathname(page).startsWith("/settings"),
      pathname(page),
    );

    await page.goBack();
    await page.waitForTimeout(800);
    r.ok(
      "B: Back restores exact deep link",
      pathname(page) === deep,
      pathname(page),
    );
    const state = await historyState(page);
    r.ok(
      "B: restored entry carries tabId+appId",
      !!state?.tabId && !!state?.appId,
      JSON.stringify(state)?.slice(0, 120),
    );
    // Content/theme coherence: the Settings sidebar must be gone after Back.
    const settingsLeftovers = await page
      .getByText("Appearance", { exact: true })
      .count();
    r.ok(
      "B: no Settings content leftover",
      settingsLeftovers === 0,
      `${settingsLeftovers} matches`,
    );
    await snap(page, out, "B-back");

    const before = await persistedTabs(page);
    await page.reload();
    await settle(page);
    const after = await persistedTabs(page);
    r.ok(
      "B: reload mints no phantom tab",
      before !== null &&
        after !== null &&
        after.tabs.length === before.tabs.length,
      `before=${before?.tabs.length} after=${after?.tabs.length}`,
    );
    r.ok("B: URL survives reload", pathname(page) === deep, pathname(page));
    await page.close();
  }

  // ---- Scenario C: new tab (+) pushes; Back refocuses the previous tab ----
  {
    const page = await context.newPage();
    await page.goto(pathUrl("/story"));
    await settle(page);
    const t0 = await persistedTabs(page);

    await page.getByRole("button", { name: /New tab|New window/ }).click();
    await page.waitForTimeout(800);
    const t1 = await persistedTabs(page);
    r.ok(
      "C: + opened a second tab",
      t1?.tabs.length === (t0?.tabs.length ?? 1) + 1,
      `tabs=${t1?.tabs.length}`,
    );

    await page.goBack();
    await page.waitForTimeout(800);
    const t2 = await persistedTabs(page);
    r.ok(
      "C: Back refocuses previous tab",
      t2?.focusedTabId === t0?.focusedTabId,
      `focused=${t2?.focusedTabId?.slice(0, 8)}`,
    );
    r.ok(
      "C: Back restores previous URL",
      pathname(page) === "/story",
      pathname(page),
    );
    await page.close();
  }

  // ---- Scenario D: reload mid-history keeps back-target (tabId survival) ----
  {
    const page = await context.newPage();
    await page.goto(pathUrl("/story"));
    await settle(page);
    await clickRailApp(page, "Settings");
    await page.reload();
    await settle(page);
    await page.goBack();
    await page.waitForTimeout(800);
    r.ok(
      "D: Back after reload returns to /story",
      pathname(page) === "/story",
      pathname(page),
    );
    await page.close();
  }

  // ---- Scenario E: app instances — fresh on a bookmark, preserved otherwise ----
  {
    // The two URLs this scenario chooses; everything else is OBSERVED from the
    // page rather than assumed. In particular the pre-bookmark pathname is NOT
    // `/agents`: the `+` button opens a Home tab (app-tab-bar.tsx → openTab
    // ("home")), so the focused tab — and the last history entry — is Home's by
    // the time we navigate away. Asserting a URL this scenario didn't observe is
    // how that bit us once already.
    const startPath = "/agents";
    const bookmarkPath = "/sonata";
    const page = await context.newPage();

    // 1. A populated instance to (not) inherit: the /agents tab plus whatever
    //    the `+` button opens beside it.
    await page.goto(pathUrl(startPath));
    await settle(page);
    await page.getByRole("button", { name: /New tab|New window/ }).click();
    await page.waitForTimeout(800);
    const before = await persistedTabs(page);
    const preBookmarkEntry = await historyState(page);
    const preBookmarkInstance = await currentInstance(page);
    // The pathname the focused tab is actually showing, captured immediately
    // before the bookmark navigation — this is Back's target in step 5.
    const preBookmarkPath = pathname(page);
    r.ok(
      "E1: a second in-app tab is open",
      before?.tabs.length === 2,
      `tabs=${before?.tabs.length}`,
    );

    // 2. The bookmark click: a REAL cross-document navigation to another app.
    //    The reported bug was the previous instance's tabs surviving alongside
    //    a newly-minted one.
    await page.goto(pathUrl(bookmarkPath));
    await settle(page);
    const fresh = await persistedTabs(page);
    r.ok(
      `E2: bookmark to ${bookmarkPath} mints a fresh instance (exactly ONE tab)`,
      fresh?.tabs.length === 1,
      `tabs=${fresh?.tabs.length}`,
    );
    r.ok(
      "E2: the one tab belongs to the URL's app",
      fresh?.tabs[0]?.appId === "sonata",
      String(fresh?.tabs[0]?.appId),
    );
    await snap(page, out, "E-fresh");

    // 3. Surface mode + window geometry are INSTANCE state, so both reset.
    const freshInstance = await currentInstance(page);
    // The one value here this scenario can't observe from the page: the
    // registered default placement id, which is `docked` (the `default: true`
    // Surface.Placement — surface/plugins/docked/web/docked-placement.tsx). `""`
    // is bootTabs' pre-registration seed, which the provider resolves to that
    // same default at render — so both values mean "the default", and neither is
    // an inherited `floating` / `solo`.
    r.ok(
      "E3: surface mode is the default, never inherited",
      fresh?.mode === "docked" || fresh?.mode === "",
      String(fresh?.mode),
    );
    const geometry = freshInstance
      ? await hasWindowGeometry(page, freshInstance.gen)
      : true;
    r.ok(
      "E3: no window geometry for the new instance",
      geometry === false,
      `hasGeometry=${geometry}`,
    );

    // 4. A reload PRESERVES the instance — same generation, same tab set.
    await page.reload();
    await settle(page);
    const reloaded = await persistedTabs(page);
    const reloadedInstance = await currentInstance(page);
    r.ok(
      "E4: reload keeps the same instance",
      !!freshInstance && reloadedInstance?.gen === freshInstance.gen,
      `${freshInstance?.gen.slice(0, 8)} → ${reloadedInstance?.gen.slice(0, 8)}`,
    );
    r.ok(
      "E4: reload keeps the fresh instance's tab set",
      !!fresh && reloaded?.tabs.length === fresh.tabs.length,
      `${reloaded?.tabs.length} of ${fresh?.tabs.length}`,
    );

    // 5. Back restores the PREVIOUS instance in full — every tab and its focus.
    await page.goBack();
    await settle(page);
    const restored = await persistedTabs(page);
    r.ok(
      "E5: Back returns to the pre-bookmark URL",
      pathname(page) === preBookmarkPath,
      `${pathname(page)} != ${preBookmarkPath}`,
    );
    r.ok(
      "E5: Back restores the whole previous instance (every tab)",
      !!before && restored?.tabs.length === before.tabs.length,
      `${restored?.tabs.length} of ${before?.tabs.length}`,
    );
    r.ok(
      "E5: Back restores the pre-bookmark focus",
      !!before?.focusedTabId && restored?.focusedTabId === before.focusedTabId,
      `focused=${restored?.focusedTabId?.slice(0, 8)}`,
    );
    await snap(page, out, "E-back");

    // 6. Forward returns to the fresh single-tab instance.
    await page.goForward();
    await settle(page);
    const forward = await persistedTabs(page);
    r.ok(
      `E6: Forward returns to ${bookmarkPath}`,
      pathname(page) === bookmarkPath,
      pathname(page),
    );
    r.ok(
      "E6: Forward keeps the fresh instance's tab set",
      !!fresh && forward?.tabs.length === fresh.tabs.length,
      `${forward?.tabs.length} of ${fresh?.tabs.length}`,
    );

    // 7. Pin the MECHANISM, not just the symptom: the two entries name two
    //    different app instances — that is what made step 2 start clean.
    const bookmarkEntry = await historyState(page);
    r.ok(
      "E7: the pre-bookmark and bookmark entries name different app instances",
      !!preBookmarkEntry?.appInstance &&
        !!bookmarkEntry?.appInstance &&
        preBookmarkEntry.appInstance !== bookmarkEntry.appInstance,
      `${preBookmarkEntry?.appInstance?.slice(0, 8)} vs ${bookmarkEntry?.appInstance?.slice(0, 8)}`,
    );
    r.ok(
      "E7: instance ids differ from the browser-tab id",
      !!preBookmarkInstance &&
        preBookmarkInstance.gen !== preBookmarkInstance.tabId,
      `${preBookmarkInstance?.gen.slice(0, 8)} vs tab ${preBookmarkInstance?.tabId.slice(0, 8)}`,
    );
    await page.close();
  }

  await r.finish();
});
