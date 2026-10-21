/**
 * Config on live values, end to end on a deployed build
 * (research/2026-09-27-global-config-live-values-optional-params.md).
 *
 * Config's documents are a parameterized `liveValue` (`config-v2.values`,
 * `{ path, scopeId? }`) preloaded through the BOOT SNAPSHOT — config's own boot
 * task and `GET /api/config-v2/snapshot` are gone. This drives what that must
 * keep true:
 *
 *   1. the boot snapshot ships every document a first paint can read: a
 *      `{ path }` per registered path (the keys of `config-v2.scopes`, which
 *      lists every one) and a `{ path, scopeId }` per scope the map lists —
 *      canonical (no `scopeId: ""`), and the old endpoint answers 404;
 *   2. a page load never asks for the old endpoint;
 *   3. an absent optional param is one tuple over HTTP too (`?scopeId=` reads
 *      the base document), and a scoped document reads back as the boot
 *      snapshot shipped it;
 *   4. a config write propagates LIVE to a second browser context (a separate
 *      socket) — the floating action bar's `enabled` toggle hides the bar;
 *   5. FIRST PAINT: a fresh page after that write never paints the default
 *      (`enabled: true`) even for one frame — a MutationObserver installed
 *      before any script runs records whether the bar ever entered the DOM;
 *   6. Settings → Config opens a descriptor's detail pane (values, scopes,
 *      conflicts, tiers) without "Config not found".
 *
 * WRITES: `shell/global-action-bar` `enabled` through the app's own
 * set-field endpoint, agent-marked — `withBrowser` reverts it at the end of
 * the run (and at the start of the next, if this one is killed).
 *
 * Usage:
 *   ./singularity run plugins/config_v2/e2e/config-live-values.ts [--headed]
 */

import {
  agentFetch,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const OUT = "/tmp/claude-501/config-live-values";
const r = report(
  "config_v2 · documents as live values, preloaded by the boot snapshot",
);

const BAR_PATH = "shell/global-action-bar/config.jsonc";
const BAR = "button[data-health]";

type Params = Record<string, string>;
interface BootSnapshot {
  resources: Record<string, unknown>;
  tuples: Record<string, { params: Params; value: unknown }[]>;
}

async function readJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await agentFetch(path);
  const text = await res.text();
  // Only a 200 carries JSON here; a 404 body is plain text.
  return {
    status: res.status,
    body: (res.status === 200 ? JSON.parse(text) : null) as T,
  };
}

async function readValue(params: string): Promise<unknown> {
  const { status, body } = await readJson<{ value: unknown }>(
    `/api/resources/config-v2.values?${params}`,
  );
  if (status !== 200) throw new Error(`config-v2.values?${params} → ${status}`);
  return body.value;
}

async function setEnabled(value: boolean): Promise<void> {
  const res = await agentFetch("/api/config-v2/set-field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storePath: BAR_PATH, key: "enabled", value }),
  });
  if (!res.ok)
    throw new Error(`set-field → ${res.status}: ${await res.text()}`);
}

const barCount = (page: Page) => page.locator(BAR).count();

await withBrowser(async (h) => {
  // ── 1. The boot snapshot ──────────────────────────────────────────────────
  const snapRes = await readJson<BootSnapshot>("/api/resources/boot-snapshot");
  r.eq("boot snapshot answers", snapRes.status, 200);
  const scopes = snapRes.body.resources["config-v2.scopes"] as
    Record<string, string[]> | undefined;
  const docs = snapRes.body.tuples["config-v2.values"] ?? [];
  r.ok("config-v2.scopes is preloaded", scopes !== undefined);
  const paths = Object.keys(scopes ?? {});
  const shipped = new Set(docs.map((d) => JSON.stringify(d.params)));
  const want: Params[] = [];
  for (const path of paths) {
    want.push({ path });
    for (const scopeId of scopes![path]!) want.push({ path, scopeId });
  }
  r.ok(
    `every registered document is preloaded (${want.length} = ${paths.length} base + ${want.length - paths.length} scoped)`,
    want.every((p) => shipped.has(JSON.stringify(p))) &&
      docs.length === want.length,
    `shipped ${docs.length}, missing ${want.filter((p) => !shipped.has(JSON.stringify(p))).length}`,
  );
  r.ok(
    "every shipped tuple is canonical (no empty scopeId)",
    docs.every((d) => d.params.scopeId !== ""),
  );
  r.ok("the bar's document is registered", paths.includes(BAR_PATH));
  const old = await readJson<unknown>("/api/config-v2/snapshot");
  r.eq("config's own snapshot endpoint is gone", old.status, 404);

  // ── 3. One tuple per spelling; a scoped document ─────────────────────────
  const enc = encodeURIComponent(BAR_PATH);
  r.eq(
    "?scopeId= (empty) reads the base document",
    await readValue(`path=${enc}&scopeId=`),
    await readValue(`path=${enc}`),
  );
  const scoped = docs.find((d) => d.params.scopeId !== undefined);
  if (scoped) {
    const q = `path=${encodeURIComponent(scoped.params.path!)}&scopeId=${encodeURIComponent(scoped.params.scopeId!)}`;
    r.eq(
      `a scoped document reads back as preloaded (${scoped.params.path} @ ${scoped.params.scopeId})`,
      await readValue(q),
      scoped.value,
    );
  } else {
    r.ok("a scoped document exists to check", false, "no scoped tuple shipped");
  }

  // Start from a shown bar, whatever this namespace's user config says.
  await setEnabled(true);

  // ── 2 + 4. Two contexts: no old endpoint; a write propagates live ────────
  const a = await h.session({ label: "A" });
  const b = await h.session({ label: "B" });
  const oldAsks: string[] = [];
  for (const s of [a, b]) {
    s.page.on("request", (req) => {
      if (req.url().includes("/api/config-v2/snapshot"))
        oldAsks.push(req.url());
    });
  }
  await boot(a.page, pathUrl("/"), { marker: BAR, settleMs: 500 });
  await boot(b.page, pathUrl("/"), { marker: BAR, settleMs: 500 });
  r.eq("no page load asks for the old snapshot endpoint", oldAsks, []);
  r.ok("the bar is shown while enabled (B)", (await barCount(b.page)) > 0);

  await setEnabled(false);
  const hidden = await waitFor(
    () => barCount(b.page),
    (n) => n === 0,
    {
      timeoutMs: 10_000,
    },
  );
  r.ok("a write reaches another context live: the bar hides", hidden.ok);
  const hiddenA = await waitFor(
    () => barCount(a.page),
    (n) => n === 0,
    {
      timeoutMs: 10_000,
    },
  );
  r.ok("…and in the first context", hiddenA.ok);

  // ── 5. First paint after the write: never the default, not for a frame ──
  const c = await h.session({ label: "C" });
  await c.page.addInitScript((selector: string) => {
    const w = window as unknown as { __barEverShown?: boolean };
    w.__barEverShown = false;
    const seen = () => {
      if (document.querySelector(selector)) w.__barEverShown = true;
    };
    new MutationObserver(seen).observe(document, {
      subtree: true,
      childList: true,
    });
  }, BAR);
  await boot(c.page, pathUrl("/"), { settleMs: 2500 });
  const everShown = await c.page.evaluate(
    () => (window as unknown as { __barEverShown?: boolean }).__barEverShown,
  );
  r.eq(
    "first paint reads the written value — the bar never appears",
    everShown,
    false,
  );

  // Back on: the same fresh-context paint shows it.
  await setEnabled(true);
  const shownAgain = await waitFor(
    () => barCount(b.page),
    (n) => n > 0,
    {
      timeoutMs: 10_000,
    },
  );
  r.ok("re-enabling shows it again live", shownAgain.ok);

  // ── 6. Settings → Config detail pane (a descriptor with per-app scopes) ──
  // `theme` (the theme selection) is customized for several apps, so its pane
  // reads the document, the scopes map (its tabs), conflicts and tiers.
  await boot(a.page, pathUrl("/settings/config"), { settleMs: 4000 });
  await a.page
    .getByPlaceholder(/^Search/)
    .first()
    .fill("theme");
  // The nav is a tree (ui › theme-engine › theme): the descriptor's own row is
  // the leaf, named after the descriptor. The filtered tree can take seconds
  // to settle, so wait for the row rather than a fixed delay.
  const row = a.page.locator('text="theme"').first();
  const rowFound = await row
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(
      () => true,
      (err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return false;
        throw err;
      },
    );
  if (rowFound) {
    await row.click();
    await a.page.waitForTimeout(3000);
  }
  const notFound = await a.page.getByText("Config not found").count();
  const baseTab = await a.page.getByText("Base", { exact: true }).count();
  r.ok(
    "Settings → Config opens a scoped descriptor, with its scope tabs",
    rowFound && notFound === 0 && baseTab > 0,
    `row ${rowFound}, not-found ${notFound}, Base tab ${baseTab}`,
  );
  await snap(a.page, OUT, "settings");

  for (const s of [a, b, c]) {
    const errs = [...s.captured.pageErrors, ...s.captured.consoleErrors].filter(
      (e) => /config-v2|boot-snapshot/i.test(e),
    );
    r.eq(`no config / boot-snapshot errors in ${s.label}`, errs, []);
  }
  await r.finish();
});
