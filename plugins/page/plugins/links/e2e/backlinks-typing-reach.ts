// Measures what reaches `page-backlinks` while a person types, in a real
// browser against this checkout's build: the value's loader runs and its
// change-feed notifies (the runtime's `GET /api/resources/_debug` counters),
// per phase.
//
// Setup: a target page T (left open, so its backlinks are subscribed) and a
// source page S whose second block is a link to T (a pasted page id), its
// first block plain text.
//
// Phases:
//   A. typing in T's own content — nothing T's backlinks read moves;
//   B. typing in S's plain block (not the linking one) — nothing moves either;
//   C. renaming S — the backlink row's title moves: it must still reach, and
//      the row on T must show the new title (the positive control).
//
// A and B are where a whole-table read set recomputed the value on every
// typing projection and pushed identical bytes; C proves the narrowed reads
// still carry every change that matters.
//
// Usage: ./equin run plugins/page/plugins/links/e2e/backlinks-typing-reach.ts
//        [--chars 30] [--gap 250] [--setup-settle 20000]
import type { Page } from "playwright";
import {
  ELEMENT_TIMEOUT_MS,
  numArg,
  pageFetch,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  editableBlocks,
  openBlankPage,
} from "@plugins/page/plugins/editor/e2e";

const CHARS = numArg("chars", 30);
const GAP_MS = numArg("gap", 250);
/** Past the editor's ~1s `data.text` projection debounce and the feed's flush. */
const SETTLE_MS = 4000;
const KEY = "page-backlinks";
/**
 * After setup: `pages/auto-icon` picks each new page an emoji (a model call)
 * some seconds after its title is set — a REAL change to the source's
 * backlink row (its icon), which must reach. Let it land before measuring.
 */
const SETUP_SETTLE_MS = numArg("setup-settle", 20_000);
/** The header toggle, whatever faces (the sources' icons) precede its words. */
const LINKED_FROM_ONE = /Linked from 1 page$/;

const r = report();

interface Counters {
  loaderRuns: number;
  feedNotifies: number;
  tuples: number;
}

interface DebugEntry {
  key: string;
  tuples: number;
  loaderStats?: { count: number };
  notifyStats: { feed: number };
}

/** `page-backlinks`' counters, read through the page's own origin. */
async function counters(page: Page): Promise<Counters> {
  const res = await pageFetch(page, "/api/resources/_debug");
  if (!res.ok) throw new Error(`_debug: HTTP ${res.status}`);
  const { resources } = (await res.json()) as { resources: DebugEntry[] };
  const entry = resources.find((e) => e.key === KEY);
  if (!entry) throw new Error(`_debug lists no "${KEY}" entry`);
  return {
    loaderRuns: entry.loaderStats?.count ?? 0,
    feedNotifies: entry.notifyStats.feed,
    tuples: entry.tuples,
  };
}

/** Type `n` characters one at a time, `GAP_MS` apart — a person typing. */
async function typeSlowly(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.keyboard.type(String.fromCharCode(97 + (i % 26)));
    await page.waitForTimeout(GAP_MS);
  }
  await page.waitForTimeout(SETTLE_MS);
}

async function phase(
  label: string,
  tab: Page,
  act: () => Promise<void>,
): Promise<{ loaderRuns: number; feedNotifies: number }> {
  const before = await counters(tab);
  await act();
  const after = await counters(tab);
  if (after.loaderRuns < before.loaderRuns) {
    throw new Error(
      `${label}: the profiling window reset mid-phase (loader count ${before.loaderRuns} → ${after.loaderRuns}) — rerun`,
    );
  }
  const delta = {
    loaderRuns: after.loaderRuns - before.loaderRuns,
    feedNotifies: after.feedNotifies - before.feedNotifies,
  };
  console.log(
    `[${label}] ${KEY}: loader runs +${delta.loaderRuns}, feed notifies +${delta.feedNotifies} (tuples ${after.tuples})`,
  );
  return delta;
}

await withBrowser(async (h) => {
  const { context, page: tabT } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // ---- T: the target, left open so its backlinks stay subscribed -----------
  const target = await openBlankPage(tabT, { settleMs: 1500 });
  const titleT = tabT.getByLabel("Page title");
  await titleT.fill("Backlinks target");
  await target.block.click();
  await tabT.keyboard.type("Target body ");

  // ---- S: a plain block, then a link to T in the next one ------------------
  const tabS = await context.newPage();
  await openBlankPage(tabS, { settleMs: 1500 });
  await tabS.getByLabel("Page title").fill("Linking source");
  await editableBlocks(tabS).first().click();
  await tabS.keyboard.type("Intro text ");
  await tabS.keyboard.press("Enter");
  await tabS.evaluate((id) => navigator.clipboard.writeText(id), target.pageId);
  await tabS.keyboard.press("Meta+v");

  // The edge reaches T: its header counts one linking page.
  await tabT
    .getByRole("button", { name: LINKED_FROM_ONE })
    .waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  r.ok("setup: T shows one linking page", true);
  await tabT.waitForTimeout(SETUP_SETTLE_MS);

  // ---- A: typing in T's own content ----------------------------------------
  await tabT.bringToFront();
  await target.block.click();
  await tabT.keyboard.press("End");
  const a = await phase("A: type in the target page", tabT, () =>
    typeSlowly(tabT, CHARS),
  );
  r.eq("A: typing in T recomputes T's backlinks 0 times", a.loaderRuns, 0);

  // ---- B: typing in S's plain (non-linking) block --------------------------
  await tabS.bringToFront();
  await editableBlocks(tabS).first().click();
  await tabS.keyboard.press("End");
  const b = await phase("B: type in the source's other block", tabT, () =>
    typeSlowly(tabS, CHARS),
  );
  r.eq("B: typing in S's other block recomputes 0 times", b.loaderRuns, 0);

  // ---- C: renaming S still reaches, and T shows it -------------------------
  const c = await phase("C: rename the source", tabT, async () => {
    await tabS.getByLabel("Page title").fill("Linking source renamed");
    await tabS.waitForTimeout(SETTLE_MS);
  });
  r.ok("C: renaming S recomputes T's backlinks", c.loaderRuns >= 1);
  await tabT.bringToFront();
  await tabT.getByRole("button", { name: LINKED_FROM_ONE }).click();
  await tabT
    .getByLabel("Pages linking here")
    .getByText("Linking source renamed")
    .first()
    .waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  r.ok("C: T's backlink row shows the new title", true);
});
