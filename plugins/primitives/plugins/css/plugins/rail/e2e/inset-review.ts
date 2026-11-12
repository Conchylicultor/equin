// Before / after captures of every surface the rail contract's region owners
// can reach (research/2026-11-09-global-surface-owned-inset.md, "Visual review
// deliverable"): one PNG per surface, same viewport, scheme and settle, so a
// pair taken around a change differs only by the change.
//
//   ./equin run plugins/primitives/plugins/css/plugins/rail/e2e/inset-review.ts \
//     --out "$EQUIN_SCRATCH/inset-review" --suffix before [--only a,b]
//
// Writes `<out>/<surface>-<suffix>.png` and prints, per surface, `ok` or
// `FAILED <why>` (the run goes on), plus `measure <surface> {…}` for the
// surfaces that declare px measurements.
//
// Onboarding never sits on a capture: the hints engine's own e2e helper answers
// each tip with its own "Got it" as it shows (which records it seen, so the
// next run starts with it already answered), and before every snap the script
// waits out a tip's arrival window and refuses to shoot while any piece of the
// hints stage (a tip card, a halo, a tour) is on screen.
//
// A surface that needs data opens on a blank page created through the app
// (`openBlankPage`) in THIS checkout's database; every page the run created is
// deleted at the end.

import type { Locator, Page } from "playwright";
import {
  arg,
  agentFetch,
  pathUrl,
  withBrowser,
  waitForNetworkIdle,
  waitForNotBusy,
  ELEMENT_TIMEOUT_MS,
  snap,
  clearToasts,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { answerTipsAsTheyShow } from "@plugins/hints/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

type Step =
  /** Hover the floating global action bar open. */
  | { actionBar: true }
  /** Hover the first visible match of a Playwright selector. */
  | { hover: string }
  /** Click the first visible button whose accessible name matches. */
  | { button: string | RegExp }
  /** Click the first visible match of a Playwright selector. */
  | { click: string }
  /** Press a key (Playwright key spelling). */
  | { press: string }
  /** Type text into whatever has focus. */
  | { type: string };

type Measure = (page: Page) => Promise<Record<string, number>>;

interface Surface {
  name: string;
  /** A route, or `blank-page`: a page created for this surface (removed at the end). */
  path: string;
  steps?: readonly Step[];
  measure?: Measure;
}

const SONG = "song-1791710976-b16ii1";
const CONVERSATION = "conv-1794237879-6p4ggw";
/** A finished conversation whose transcript this checkout's backend reads (Artifacts needs it). */
const ARTIFACT_CONVERSATION = "conv-1794237173-6elk86";

const SURFACES: readonly Surface[] = [
  // ── Migrated in slice 1 ──────────────────────────────────────────────
  {
    name: "tag-popover",
    path: "/prototypes",
    steps: [{ hover: '[data-ui-owner^="DataCard@"]' }, { button: "Edit tag" }],
    // The search's inset, and the footer's room: the "+ New tag" text against
    // the rule above it and the panel's bottom edge.
    measure: async (page) =>
      page.evaluate((): Record<string, number> => {
        const picker = document.querySelector("[data-tag-picker]");
        const panel = picker?.closest("[data-overlay-panel]");
        const rules = picker?.querySelectorAll('[data-slot="separator"]');
        const rule = rules?.[rules.length - 1];
        const label = [...(picker?.querySelectorAll("*") ?? [])].find(
          (e) => e.children.length === 0 && e.textContent?.trim() === "New tag",
        );
        const field = picker?.querySelector("input")?.parentElement;
        if (!panel || !rule || !label || !field) return {};
        const p = panel.getBoundingClientRect();
        const r = rule.getBoundingClientRect();
        const t = label.getBoundingClientRect();
        const s = field.getBoundingClientRect();
        return {
          searchFromPanelLeft: Math.round(s.left - p.left),
          searchFromPanelTop: Math.round(s.top - p.top),
          footerTextAboveToRule: Math.round(t.top - r.bottom),
          footerTextBelowToPanelEdge: Math.round(p.bottom - t.bottom),
        };
      }),
  },
  {
    name: "places-sidebar",
    path: "/places",
    measure: async (page) =>
      page.evaluate((): Record<string, number> => {
        const np = [...document.querySelectorAll("*")].find(
          (e) =>
            e.children.length === 0 && e.textContent?.trim() === "New preset",
        );
        const row = np?.closest("button,[role=button],a,li") ?? np;
        const picker = document.querySelector("[data-tag-picker]");
        const field = picker?.querySelector("input")?.parentElement;
        const card = picker?.closest('[class*="w-72"]');
        const rule = picker?.querySelector('[data-slot="separator"]');
        if (!row || !field || !card || !rule) return {};
        const r = row.getBoundingClientRect();
        const s = field.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        const l = rule.getBoundingClientRect();
        const tree = picker?.querySelector("[data-tree-id]");
        const t = tree?.getBoundingClientRect();
        return {
          firstTreeRowFromCardLeft: t ? Math.round(t.left - c.left) : -1,
          presetsToSearchGap: Math.round(s.top - r.bottom),
          searchFromCardLeft: Math.round(s.left - c.left),
          searchToRuleGap: Math.round(l.top - s.bottom),
          ruleFromCardLeft: Math.round(l.left - c.left),
          ruleFromCardRight: Math.round(c.right - l.right),
        };
      }),
  },
  {
    name: "build-popover",
    path: "/agents",
    steps: [{ actionBar: true }, { button: "Builds" }],
  },
  {
    name: "notifications",
    path: "/agents",
    // Its label carries the unread count ("Notifications, 3 unread").
    steps: [{ actionBar: true }, { button: /^Notifications/ }],
  },
  {
    name: "health-report",
    path: "/agents",
    steps: [{ actionBar: true }, { click: "button[data-health]" }],
  },
  {
    name: "artifacts",
    path: `/agents/c/${ARTIFACT_CONVERSATION}`,
    steps: [{ button: "Artifacts" }],
  },
  { name: "profiling", path: "/debug/profiling" },
  // ── Reached by a global change (menu search room, overlay strips, menus) ─
  {
    name: "dv-filter",
    path: "/agents/all-conversations",
    steps: [{ button: "Filter" }],
  },
  {
    name: "dv-chip-filter",
    path: "/agents/all-conversations",
    // A per-tab draft rule: never saved, gone with the session.
    steps: [
      { button: "Filter" },
      { click: '[data-overlay-panel] :text-is("Status")' },
      { click: '[data-overlay-panel] button:has-text("Select…")' },
    ],
  },
  {
    name: "dv-sort",
    path: "/agents/all-conversations",
    steps: [{ button: /^Sort/ }],
  },
  {
    name: "dv-view-settings",
    path: "/agents/all-conversations",
    steps: [{ button: "View settings" }],
  },
  {
    name: "dv-hosted-options",
    path: "/files",
    // The file tree's hosted options trigger comes first in the DOM; the
    // action bar's own "View options" is later.
    steps: [{ click: 'button[aria-label="View options"]' }],
  },
  {
    name: "command-palette",
    path: "/agents",
    steps: [{ press: "Meta+k" }],
  },
  {
    name: "pages-search",
    path: "/pages",
    steps: [{ click: 'button:has-text("Search")' }],
  },
  {
    name: "track-instrument",
    path: `/sonata/song/${SONG}`,
    steps: [{ click: 'text="Tracks"' }, { button: "Track instrument" }],
  },
  {
    name: "link-tasks",
    path: `/agents/c/${CONVERSATION}`,
    steps: [{ button: "Link tasks" }],
  },
  {
    name: "link-tasks-add",
    path: `/agents/c/${CONVERSATION}`,
    steps: [
      { button: "Link tasks" },
      { click: '[data-overlay-panel] button:has-text("Add")' },
    ],
  },
  {
    name: "entry-editor",
    path: "/studio/compositions/comp/pages",
    steps: [
      { click: 'button:has-text("Entry points")' },
      { click: 'button:has-text("Add")' },
    ],
  },
  {
    name: "page-tags",
    path: "blank-page",
    steps: [{ hover: 'input[aria-label="Page title"]' }, { button: "Add tag" }],
  },
  {
    name: "page-link-block",
    path: "blank-page",
    // A space would close the slash menu: its filter is one word.
    steps: [
      { type: "/link" },
      { press: "Enter" },
      { click: ':text("Select a page")' },
    ],
  },
  {
    name: "prototype-block",
    path: "blank-page",
    steps: [
      { type: "/prototype" },
      { press: "Enter" },
      { click: ':text("Select a prototype")' },
    ],
  },
  {
    name: "choose-model",
    path: `/agents/c/${CONVERSATION}`,
    steps: [{ button: "Choose model" }],
  },
  {
    name: "view-menu",
    path: "/agents",
    steps: [{ button: /^View: / }],
  },
  {
    name: "tag-row-menu",
    path: "/prototypes",
    steps: [
      { hover: '[data-ui-owner^="DataCard@"]' },
      { button: "Edit tag" },
      { hover: "[data-tag-picker] [data-tree-id]" },
      { click: '[data-tag-picker] [data-tree-id] button[aria-label="More"]' },
    ],
  },
];

/**
 * Measured on every surface: each visible menu search's box against the
 * floating panel (or region) it sits in — the one geometry the global change
 * (`menu-field`'s room) can move on a surface it was not migrated on.
 */
const measureMenuFields: Measure = async (page) =>
  page.evaluate((): Record<string, number> => {
    const out: Record<string, number> = {};
    const fields = [...document.querySelectorAll(".menu-field")].filter(
      (f) => f.getBoundingClientRect().width > 0,
    );
    fields.forEach((f, i) => {
      const host =
        f.closest("[data-overlay-panel]") ?? f.closest("[role=dialog]");
      if (!host) return;
      const a = f.getBoundingClientRect();
      const b = host.getBoundingClientRect();
      out[`menuField${i}Left`] = Math.round(a.left - b.left);
      out[`menuField${i}Top`] = Math.round(a.top - b.top);
      out[`menuField${i}Right`] = Math.round(b.right - a.right);
    });
    return out;
  });

/**
 * Measured on every surface with an open floating panel: where its first line
 * of text sits (a header strip's title) against the panel's left and top
 * edges, the room from that text down to the first rule under it, and where
 * the first tree row (a tag picker's) starts.
 */
const measurePanelHead: Measure = async (page) =>
  page.evaluate((): Record<string, number> => {
    const panels = [...document.querySelectorAll("[data-overlay-panel]")]
      .filter((p) => p.getBoundingClientRect().width > 0)
      // The floating action bar is an overlay panel too; the surface is the last one opened.
      .filter((p) => !p.querySelector('[class*="group/fa"]'));
    const panel = panels[panels.length - 1];
    if (!panel) return {};
    const pr = panel.getBoundingClientRect();
    const out: Record<string, number> = {};
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    let text: Text | null = null;
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      if (
        t.textContent?.trim() &&
        t.parentElement?.getBoundingClientRect().width
      ) {
        text = t;
        break;
      }
    }
    if (text) {
      const range = document.createRange();
      range.selectNodeContents(text);
      const tr = range.getBoundingClientRect();
      out.firstTextLeft = Math.round(tr.left - pr.left);
      out.firstTextTop = Math.round(tr.top - pr.top);
      const rules = [...panel.querySelectorAll("*")]
        .map((e) => ({
          e,
          r: e.getBoundingClientRect(),
          cs: getComputedStyle(e),
        }))
        .filter(
          ({ r, cs }) =>
            r.width > pr.width / 2 &&
            ((parseFloat(cs.borderBottomWidth) > 0 && r.bottom > tr.bottom) ||
              (cs.backgroundColor !== "rgba(0, 0, 0, 0)" &&
                r.height <= 1.5 &&
                r.top > tr.bottom)),
        )
        .map(({ r, cs }) =>
          parseFloat(cs.borderBottomWidth) > 0 ? r.bottom : r.top,
        )
        .sort((x, y) => x - y);
      if (rules[0] !== undefined)
        out.firstTextToRule = Math.round(rules[0] - tr.bottom);
    }
    const row = panel.querySelector("[data-tree-id]");
    if (row) {
      const rr = row.getBoundingClientRect();
      out.firstTreeRowLeft = Math.round(rr.left - pr.left);
      out.firstTreeRowTop = Math.round(rr.top - pr.top);
    }
    return out;
  });

const out = arg("out", "/tmp/inset-review");
const suffix = arg("suffix", "shot");
const only = arg("only")?.split(",");
/** Extra page ids to remove with the run's own fixtures (a page left by a hand probe). */
const removeExtra = arg("remove")?.split(",") ?? [];

/** Every piece the hints stage draws while it is showing something. */
const HINT_ON_SCREEN =
  '.hint-card[data-on="true"], .hint-halo[data-on="true"], .hint-welcome[data-on="true"], .hint-toast[data-on="true"]';
/** A shown tip's own answer button (the engine's dismissal). */
const SHOWN_TIP_BUTTON =
  '.hint-card[data-variant="tip"][data-on="true"] button';

async function settle(page: Page): Promise<void> {
  await waitForNetworkIdle(page);
  await waitForNotBusy(page, { timeoutMs: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(2500);
}

/**
 * Wait out a tip's arrival (the orientation window plus a quiet pause, ~2 s),
 * answer any tip that showed with its own button, and refuse the shot while
 * anything of the hints stage is still up.
 */
async function clearHints(page: Page): Promise<string | null> {
  await page.waitForTimeout(2200);
  for (let i = 0; i < 4; i++) {
    if ((await page.locator(SHOWN_TIP_BUTTON).count()) === 0) break;
    await page.evaluate((s) => {
      for (const b of document.querySelectorAll<HTMLElement>(s)) b.click();
    }, SHOWN_TIP_BUTTON);
    // The card's exit, and the next tip's settle window.
    await page.waitForTimeout(1500);
  }
  const left = await page.locator(HINT_ON_SCREEN).count();
  return left === 0 ? null : `${left} hint overlay(s) still on screen`;
}

/**
 * Click, and when actionability never settles (a toolbar whose measuring layer
 * sits over its items, a hover-revealed cluster), click through it once the
 * element is there — the shot shows whether it opened.
 */
async function clickResilient(target: Locator): Promise<void> {
  await target.waitFor({ timeout: 60_000 });
  try {
    await target.click({ timeout: 10_000 });
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
    await target.click({ force: true });
  }
}

async function perform(page: Page, step: Step): Promise<void> {
  if ("actionBar" in step) {
    await page.locator('[class*="group/fa"]').first().hover();
  } else if ("hover" in step) {
    await page.locator(step.hover).filter({ visible: true }).first().hover();
  } else if ("button" in step) {
    await clickResilient(
      page
        .getByRole("button", {
          name: step.button,
          exact: typeof step.button === "string",
        })
        // An adaptive bar keeps a hidden copy of each item for its overflow.
        .filter({ visible: true })
        .first(),
    );
  } else if ("click" in step) {
    await clickResilient(
      page.locator(step.click).filter({ visible: true }).first(),
    );
  } else if ("type" in step) {
    await page.keyboard.type(step.type, { delay: 30 });
  } else {
    await page.keyboard.press(step.press);
  }
  await page.waitForTimeout(1200);
}

const createdPages: string[] = [...removeExtra];

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
  });
  await answerTipsAsTheyShow(page);
  try {
    for (const s of SURFACES) {
      if (only && !only.includes(s.name)) continue;
      let failed: string | null = null;
      try {
        if (s.path === "blank-page") {
          const doc = await openBlankPage(page, { settleMs: 2000 });
          createdPages.push(doc.pageId);
        } else {
          await page.goto(pathUrl(s.path), { waitUntil: "domcontentloaded" });
        }
        await settle(page);
        await clearToasts(page);
        for (const step of s.steps ?? []) {
          try {
            await perform(page, step);
          } catch (err) {
            throw new Error(
              `${JSON.stringify(step)}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
              { cause: err },
            );
          }
        }
        failed = await clearHints(page);
        // A report toast can land mid-run; it is not part of any surface.
        await clearToasts(page);
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
      }
      if (failed !== null) {
        console.log(`${s.name}: FAILED ${failed}`);
        process.exitCode = 1;
        continue;
      }
      const measured = {
        ...(await measurePanelHead(page)),
        ...(await measureMenuFields(page)),
        ...(s.measure ? await s.measure(page) : {}),
      };
      if (Object.keys(measured).length > 0) {
        console.log(`measure ${s.name} ${JSON.stringify(measured)}`);
      }
      const shot = await snap(page, `${out}/${s.name}`, suffix);
      console.log(`${s.name}: ${shot.ok ? "ok" : "FAILED (snap)"}`);
      if (!shot.ok) process.exitCode = 1;
    }
  } finally {
    for (const id of createdPages) {
      const res = await agentFetch(`/api/blocks/${id}`, { method: "DELETE" });
      console.log(`removed fixture page ${id}: ${res.status}`);
    }
  }
});
