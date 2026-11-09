// What the demo's e2e scripts share: driving Pages inside the `/demo` embed,
// and reaching the demo's stored data the way a later build would find it.
import type { Locator, Page } from "playwright";
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
import {
  DEMO_FULL,
  demoApp,
  demoAtRoute,
} from "@plugins/apps/plugins/demo/plugins/shell/core";
import {
  waitFor,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/** How long an app swap, a worker read or a host boot gets to render. */
export const RENDER_TIMEOUT_MS = 30_000;
/** A control the Agent Manager shows once the demo has booted. */
export const MARKER = 'button:has-text("Conversations")';

/** The seeded root pages (`website/demos/workspace`'s `core/internal/pages.ts`). */
export const ROOT_PAGES = [
  "Welcome to equin",
  "Piano practice",
  "Ideas",
] as const;

/**
 * The Agent Manager at the practice-timer conversation — where the demo used
 * to open, and where the scripts driving the Agent Manager start (the
 * workspace scenario's route, `website/demos/workspace`'s `scenario.ts`).
 */
export const AGENT_MANAGER_LOCATION = "/agents/c/conv-demo-practice-timer";

/**
 * The demo page at `location` inside the demo (an app-rooted URL,
 * `/agents/c/x`), framed — or `full` screen — as the demo writes it.
 */
export function demoPath(location: string, opts?: { full?: boolean }): string {
  return demoAtRoute.link(demoApp, {
    url: location.replace(/^\/+/, ""),
    full: opts?.full === true ? DEMO_FULL : undefined,
  });
}

/**
 * Whether `url` is still the demo page (`/demo`, `/demo/at/…`): a move
 * inside the demo rewrites the page's URL, but never leaves it for the app it
 * shows.
 */
export function onDemoPage(url: string): boolean {
  const { pathname } = new URL(url);
  return pathname === "/demo" || pathname.startsWith("/demo/");
}

export function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

/**
 * The Pages sidebar entries titled exactly `title` — after the page's icon,
 * an emoji glyph that is part of the row's text (hidden from assistive tech
 * only).
 */
export function sidebarEntries(page: Page, title: string): Locator {
  return embedRoot(page)
    .locator("[data-row-key]")
    .filter({
      hasText: new RegExp(
        `^\\s*(?:\\p{Extended_Pictographic}[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\uFE0F\\u200D]*\\s*)?${title}\\s*$`,
        "u",
      ),
    });
}

/** Switch the embed to Pages through its launcher. */
export async function openPages(
  r: Report,
  page: Page,
  step: string,
): Promise<void> {
  r.ok(
    `${step}: the launcher offers Pages`,
    await pickFromLauncher(embedRoot(page), /^\s*Pages\s*$/),
  );
  const settled = await waitFor(
    () => embedRoot(page).getAttribute("data-app-embed"),
    (id) => id === "pages",
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(`${step}: the embed shows Pages`, settled.ok, String(settled.value));
}

/** Create a root page through the sidebar's "New page" and title it `title`. */
export async function createPage(page: Page, title: string): Promise<void> {
  await embedRoot(page).getByText("New page", { exact: true }).first().click();
  const detail = embedRoot(page).locator('[data-pane-id="page-detail"]').last();
  await detail.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const titleField = detail.locator('input[aria-label="Page title"]').first();
  await titleField.fill(title);
  await titleField.press("Enter");
}

/**
 * Wait until the sidebar lists `title` as `want` says — exactly n times, or
 * `"some"`: at least once (the sidebar shows a page in several sections).
 * Returns how many times it did.
 */
export async function listed(
  r: Report,
  page: Page,
  name: string,
  title: string,
  want: number | "some",
): Promise<number> {
  const settled = await waitFor(
    () => sidebarEntries(page, title).count(),
    (count) => (want === "some" ? count > 0 : count === want),
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(
    name,
    settled.ok,
    `"${title}" listed ${settled.value}× (want ${want}; waited ${settled.waitedMs} ms)`,
  );
  return settled.value;
}

/** How long a sidebar count must hold before it is the settled one. */
const COUNT_STEADY_MS = 1_500;

/**
 * How many times the sidebar lists `title` once the sidebar has settled: the
 * count, once listed at all, holds unchanged for {@link COUNT_STEADY_MS}. Its
 * sections load one by one (a starred page shows in Favorites as well), so the
 * first count above zero is not yet the whole sidebar — the baseline a later
 * comparison needs is the settled one.
 */
export async function settledCount(
  r: Report,
  page: Page,
  name: string,
  title: string,
): Promise<number> {
  let last = -1;
  let since = 0;
  const settled = await waitFor(
    async () => {
      const count = await sidebarEntries(page, title).count();
      const now = Date.now();
      if (count !== last) {
        last = count;
        since = now;
      }
      return { count, steadyMs: now - since };
    },
    ({ count, steadyMs }) => count > 0 && steadyMs >= COUNT_STEADY_MS,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(
    name,
    settled.ok,
    `"${title}" listed ${settled.value.count}× (steady for ${settled.value.steadyMs} ms; waited ${settled.waitedMs} ms)`,
  );
  return settled.value.count;
}

/** Wait until the embed shows `app` — after a Reset, the remounted demo opens on its own app again. */
export async function showsApp(
  r: Report,
  page: Page,
  name: string,
  app: string,
): Promise<void> {
  const settled = await waitFor(
    // While the host reboots there is no embed at all.
    async () =>
      (await embedRoot(page).count()) === 0
        ? null
        : embedRoot(page).getAttribute("data-app-embed"),
    (id) => id === app,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(name, settled.ok, String(settled.value));
}

// ── The demo's stored data (`framework/browser-server/host-storage`) ────────

/** The demo's storage name (`website/demos/workspace`'s `bin/browser-host.ts`). */
const DEMO_STORAGE = "demo-workspace";

/**
 * Wait until no worker holds the demo's storage: its owner's Web Lock
 * (`equin-host:<name>`) is released once the worker closed it — after the
 * last tab of the demo went away. `page` is any page of the origin that does
 * not open the demo.
 */
export async function waitForStorageReleased(
  r: Report,
  page: Page,
  name: string,
): Promise<void> {
  const settled = await waitFor(
    () =>
      page.evaluate(async (lock) => {
        const { held } = await navigator.locks.query();
        return (held ?? []).some((l) => l.name === lock);
      }, `equin-host:${DEMO_STORAGE}`),
    (held) => !held,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(name, settled.ok, `waited ${settled.waitedMs} ms`);
}

/**
 * Make the stored demo data read as started from an OLDER snapshot than any
 * build's — what a visitor's data looks like when the build they open next
 * ships a newer one. Rewrites the storage's lifecycle record (its `snapshot`)
 * in place; the storage must be closed (`waitForStorageReleased`). Returns the
 * version the record held.
 */
export async function backdateStoredSnapshot(page: Page): Promise<string> {
  return page.evaluate(async (name) => {
    const open = (): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(`equin-host--${name}--stores`);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const db = await open();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const record = await new Promise<{
        snapshot?: { version: string; takenAt: number };
      }>((resolve, reject) => {
        const req = store.get("lifecycle");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (record?.snapshot === undefined)
        throw new Error(
          `the demo's lifecycle record names no snapshot: ${JSON.stringify(record)}`,
        );
      const was = record.snapshot.version;
      store.put(
        { ...record, snapshot: { version: "older-build", takenAt: 0 } },
        "lifecycle",
      );
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      return was;
    } finally {
      db.close();
    }
  }, DEMO_STORAGE);
}
