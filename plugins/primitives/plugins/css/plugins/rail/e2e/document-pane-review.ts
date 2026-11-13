// Before / after captures of the panes slice 2 of the surface-owned inset moved
// onto `PaneChrome inset="document"` (research/2026-11-09-global-surface-owned-inset.md,
// "Visual review deliverable"): one PNG per surface, same viewport, scheme and
// settle, plus the px edges of the rightmost pane's body content.
//
//   ./equin run plugins/primitives/plugins/css/plugins/rail/e2e/document-pane-review.ts \
//     --out "$EQUIN_SCRATCH/doc-review" --suffix before [--only a,b] \
//     [--conv <conv id> --tool-use <a non-Workflow toolu id of that conversation>]
//
// Writes `<out>/<surface>-<suffix>.png`, prints `measure <surface> {…}` (the
// body's content edges from the pane's own box: left, right, and top from the
// header's bottom) and `ok` / `FAILED <why>` per surface (the run goes on).
//
// Onboarding never sits on a capture: tips are answered as they show (the
// hints engine's own helper), and a snap is refused while any piece of the
// hints stage is up. The mail reader opens one message seeded into THIS
// deploy's database through the mail threads fixture (refused on main, every
// id under an `e2e-` prefix) and deleted at the end.

import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  withBrowser,
  waitForNetworkIdle,
  waitForNotBusy,
  ELEMENT_TIMEOUT_MS,
  snap,
  clearToasts,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { answerTipsAsTheyShow } from "@plugins/hints/e2e";
import {
  openThreadFixture,
  type ThreadFixture,
} from "@plugins/apps/plugins/mail/plugins/threads/e2e";

interface Surface {
  name: string;
  /** A route, or a function of the run's fixtures. */
  path: string | ((f: Fixtures) => string);
  /** Which pane to measure: the rightmost (default) or the leftmost. */
  pane?: "last" | "first";
  /** A button to press first, by the start of its text (a collapsed card). */
  open?: string;
}

interface Fixtures {
  mailMessageId: string;
}

const conv = arg("conv");
const toolUse = arg("tool-use");

const SURFACES: readonly Surface[] = [
  {
    name: "config-detail",
    path: "/settings/config/cd/apps%252Fchord%252Fpiano%252Fconfig.jsonc",
  },
  {
    name: "report-detail",
    path: "/debug/reports/rep/report-1794489900-k7hasg",
  },
  { name: "read-set", path: "/debug/read-set" },
  {
    name: "queue-job",
    path: "/debug/queue/queue-job/run:youtube-audio.sweep:37",
  },
  { name: "queue-dead", path: "/debug/queue/queue-dead/3204046" },
  {
    name: "queue-emission",
    path: "/debug/queue/queue-emission/fff610c9-cee0-4e7c-aa44-0d1c839b5914",
  },
  {
    name: "queue-trigger",
    path: "/debug/queue/queue-trigger/c5003920-1d8e-47b6-9da4-a228a749b0ed",
  },
  {
    name: "cli-call",
    path: "/debug/claude-cli-calls/cli-call/ef494043-ce7c-4a17-81bf-a796cb56ea23",
  },
  { name: "health-monitor", path: "/debug/health" },
  { name: "heap-snapshot", path: "/debug/heap" },
  { name: "tab-memory", path: "/debug/tab-memory" },
  { name: "live-state-health", path: "/debug/live-state" },
  { name: "live-state-emit", path: "/debug/live-state-emit" },
  {
    name: "op-detail",
    path: "/debug/op-profile/4dd06c58-8892-4a34-b38e-7f2e12c2a18e",
  },
  { name: "compare", path: "/studio/compositions/compare" },
  { name: "conv-summary", path: "/agents/c/conv-1777333537-usf7/summary" },
  { name: "server-create", path: "/deploy/servers/server/new" },
  { name: "mail-message", path: (f) => `/mail/search/m/${f.mailMessageId}` },
  // The workflow step pane, in the arms a worktree can reach without a
  // Workflow call in any transcript: a call whose input is no workflow, and
  // the pane opened with no conversation above it.
  ...(conv !== undefined && toolUse !== undefined
    ? [
        {
          name: "workflow-node",
          path: `/agents/c/${conv}/workflow-node/${toolUse}/n1`,
        },
      ]
    : []),
  { name: "workflow-node-no-conv", path: "/agents/workflow-node/toolu_x/n1" },
];

/**
 * `--set global`: what the slice's two global changes reach outside the
 * migrated panes — a grid table in a region that paid its rail (a section
 * card body, a detail-sections host), and pane headers NOT on the document
 * edge (which must be identical: `px-chrome-pane` falls back to its own token).
 */
/**
 * `--set hj`: the cross-pane header jump — the SAME screen slot showing a
 * document pane (`-doc`, header on the document edge) and then a neighbouring
 * non-document pane (`-plain`, header on the chrome pad), same app, so the
 * slider between them shows how far the header moves when switching.
 */
const HEADER_JUMP_SURFACES: readonly Surface[] = [
  {
    name: "hj-detail-doc",
    path: "/debug/reports/rep/report-1794489900-k7hasg",
  },
  { name: "hj-detail-plain", path: "/debug/build/r/build-1794488888-ghzpsm" },
  { name: "hj-full-doc", path: "/debug/heap" },
  { name: "hj-full-plain", path: "/debug/reports" },
  { name: "hj-agent-manager-doc", path: "/agents/workflow-node/toolu_x/n1" },
  { name: "hj-agent-manager-plain", path: "/agents/c/conv-1777333537-usf7" },
  {
    name: "hj-settings-doc",
    path: "/settings/config/cd/apps%252Fchord%252Fpiano%252Fconfig.jsonc",
  },
  { name: "hj-settings-plain", path: "/settings/accounts/account/google" },
];

const GLOBAL_SURFACES: readonly Surface[] = [
  // A section card body (`rail-x-lg`) holding a DataTable.
  {
    name: "g-studio-table-columns",
    path: "/studio/t/build/build_runs",
    open: "Columns",
  },
  {
    name: "g-studio-table-indexes",
    path: "/studio/t/build/build_runs",
    open: "Indexes",
  },
  // A DataTable in a pane with no region: must be identical.
  { name: "g-boot-profile", path: "/debug/boot-profile" },
  // Pane headers off the document edge: must be identical.
  { name: "g-queue-header", path: "/debug/queue", pane: "first" },
  { name: "g-reports-header", path: "/debug/reports", pane: "first" },
  {
    name: "g-contributions-header",
    path: "/studio/contributions",
    pane: "first",
  },
];

/**
 * The rightmost pane's body content edges, from the pane's own box: the
 * nearest drawn thing (text, or a box with a border or background) to its
 * left, right and top (top measured from the header's bottom).
 */
async function measureBody(
  page: Page,
  which: "last" | "first",
): Promise<Record<string, number>> {
  return page.evaluate((which): Record<string, number> => {
    const headers = [
      ...document.querySelectorAll<HTMLElement>('[data-part="pane.header"]'),
    ].filter((h) => h.getBoundingClientRect().width > 0);
    const header = headers.sort(
      (a, b) =>
        (which === "last" ? -1 : 1) *
        (a.getBoundingClientRect().left - b.getBoundingClientRect().left),
    )[0];
    const pane = header?.parentElement?.parentElement;
    if (!header || !pane) return {};
    const hr = header.getBoundingClientRect();
    const pr = pane.getBoundingClientRect();
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    const take = (r: DOMRect): void => {
      if (r.width === 0 || r.height === 0 || r.top < hr.bottom) return;
      if (r.top > window.innerHeight) return;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      top = Math.min(top, r.top);
    };
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      if (!t.textContent?.trim() || header.contains(t)) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      take(range.getBoundingClientRect());
    }
    for (const el of pane.querySelectorAll<HTMLElement>("*")) {
      if (header.contains(el)) continue;
      const cs = getComputedStyle(el);
      const drawn =
        parseFloat(cs.borderLeftWidth) > 0 ||
        parseFloat(cs.borderTopWidth) > 0 ||
        (cs.backgroundColor !== "rgba(0, 0, 0, 0)" &&
          cs.backgroundColor !== "transparent");
      const r = el.getBoundingClientRect();
      // The pane's own surfaces (its full-width body boxes) are not content.
      if (drawn && r.width < pr.width - 1) take(r);
    }
    if (left === Infinity) return {};
    // The header's text edge: the title's first glyph, from the pane's box.
    const title = header.querySelector('[data-part="pane.title"]');
    let titleLeft = -1;
    if (title) {
      const tw = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        const t = tw.currentNode as Text;
        if (!t.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        titleLeft = Math.round(range.getBoundingClientRect().left - pr.left);
        break;
      }
    }
    // A table's first data row: its rule's ends and its first cell's text.
    const table: Record<string, number> = {};
    const row = [...pane.querySelectorAll<HTMLElement>(".grid-cols-subgrid")]
      .filter((r) => r.className.includes("border-b"))
      .find((r) => !r.className.includes("sticky"));
    if (row) {
      const rr = row.getBoundingClientRect();
      table.ruleLeft = Math.round(rr.left - pr.left);
      table.ruleRight = Math.round(pr.right - rr.right);
      const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        const t = tw.currentNode as Text;
        if (!t.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        table.cellTextLeft = Math.round(
          range.getBoundingClientRect().left - pr.left,
        );
        break;
      }
    }
    // The table's column-header row height (its labels on one line).
    const headRow = [
      ...pane.querySelectorAll<HTMLElement>(".grid-cols-subgrid.sticky"),
    ][0];
    if (headRow)
      table.headerRowH = Math.round(headRow.getBoundingClientRect().height);
    // The same row against the region it sits in (its nearest rail owner).
    if (row) {
      let region: HTMLElement | null = row.parentElement;
      while (region && !/(^|\s)rail-/.test(String(region.className))) {
        region = region.parentElement;
      }
      if (region) {
        const g = region.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        table.regionRuleLeft = Math.round(rr.left - g.left);
        table.regionRuleRight = Math.round(g.right - rr.right);
        if (table.cellTextLeft !== undefined) {
          table.regionTextLeft = Math.round(
            table.cellTextLeft + pr.left - g.left,
          );
        }
      }
    }
    // A leading icon control's glyph (sidebar toggle, Back), when the header
    // starts with one: its icon box's left edge.
    let leadGlyphLeft = -1;
    const firstButton = header.querySelector("button");
    const firstSvg = firstButton?.querySelector("svg");
    if (
      firstButton &&
      firstSvg &&
      title &&
      firstButton.getBoundingClientRect().right <=
        title.getBoundingClientRect().left
    ) {
      leadGlyphLeft = Math.round(
        firstSvg.getBoundingClientRect().left - pr.left,
      );
    }
    return {
      ...table,
      leadGlyphLeft,
      titleLeft,
      // The pane's own left edge on screen, to turn the above into screen x.
      paneLeft: Math.round(pr.left),
      bodyLeft: Math.round(left - pr.left),
      bodyRight: Math.round(pr.right - right),
      bodyTop: Math.round(top - hr.bottom),
    };
  }, which);
}

/** Every piece the hints stage draws while it is showing something. */
const HINT_ON_SCREEN =
  '.hint-card[data-on="true"], .hint-halo[data-on="true"], .hint-welcome[data-on="true"], .hint-toast[data-on="true"]';
const SHOWN_TIP_BUTTON =
  '.hint-card[data-variant="tip"][data-on="true"] button';

async function clearHints(page: Page): Promise<string | null> {
  await page.waitForTimeout(2200);
  for (let i = 0; i < 4; i++) {
    if ((await page.locator(SHOWN_TIP_BUTTON).count()) === 0) break;
    await page.evaluate((s) => {
      for (const b of document.querySelectorAll<HTMLElement>(s)) b.click();
    }, SHOWN_TIP_BUTTON);
    await page.waitForTimeout(1500);
  }
  const left = await page.locator(HINT_ON_SCREEN).count();
  return left === 0 ? null : `${left} hint overlay(s) still on screen`;
}

const out = arg("out");
if (out === undefined) {
  throw new Error(
    "--out <dir> is required (a directory under your session's scratch dir)",
  );
}
const suffix = arg("suffix", "shot");
const only = arg("only")?.split(",");

let mail: ThreadFixture | null = null;
try {
  mail = await openThreadFixture();
  const thread = await mail.seed({
    name: "inset-review",
    labels: ["INBOX"],
    minutesAgo: 30,
  });
  const messageId = `${thread.id}-m1`;
  await mail.exec(
    `INSERT INTO mail_messages
       (id, thread_id, account_id, from_addr, to_addrs, subject, snippet,
        body_text, internal_date, body_fetched_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8,
             now() - interval '30 minutes', now())`,
    [
      messageId,
      thread.id,
      mail.accountId,
      JSON.stringify({ name: "Ada Example", email: "ada@example.invalid" }),
      JSON.stringify([{ name: "You", email: "you@example.invalid" }]),
      "Quarterly planning notes",
      "A seeded message for the inset review",
      "Hi,\n\nHere are the notes from Tuesday's planning session. The three priorities for the quarter are the onboarding flow, the sync reliability work and the new reporting view.\n\nThanks,\nAda",
    ],
  );
  const fixtures: Fixtures = { mailMessageId: messageId };

  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
    });
    await answerTipsAsTheyShow(page);
    const set = arg("set");
    const surfaces =
      set === "global"
        ? GLOBAL_SURFACES
        : set === "hj"
          ? HEADER_JUMP_SURFACES
          : SURFACES;
    for (const s of surfaces) {
      if (only && !only.includes(s.name)) continue;
      let failed: string | null = null;
      try {
        const path = typeof s.path === "string" ? s.path : s.path(fixtures);
        await page.goto(pathUrl(path), { waitUntil: "domcontentloaded" });
        await waitForNetworkIdle(page);
        await waitForNotBusy(page, { timeoutMs: ELEMENT_TIMEOUT_MS });
        await page.waitForTimeout(2500);
        await clearToasts(page);
        failed = await clearHints(page);
        if (failed === null && s.open !== undefined) {
          const label = s.open;
          await page
            .getByRole("button")
            .filter({ hasText: new RegExp(`^\\s*${label}`) })
            .filter({ visible: true })
            .first()
            .click();
          await page.waitForTimeout(1500);
        }
        await clearToasts(page);
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
      }
      if (failed !== null) {
        console.log(`${s.name}: FAILED ${failed}`);
        process.exitCode = 1;
        continue;
      }
      console.log(
        `measure ${s.name} ${JSON.stringify(await measureBody(page, s.pane ?? "last"))}`,
      );
      // A report toast can land at any moment; it is never part of a surface.
      await clearToasts(page);
      await page.waitForTimeout(400);
      const shot = await snap(page, `${out}/${s.name}`, suffix);
      console.log(`${s.name}: ${shot.ok ? "ok" : "FAILED (snap)"}`);
      if (!shot.ok) process.exitCode = 1;
    }
  });
} finally {
  if (mail !== null) {
    // Close the fixture even when the message delete fails (it would also
    // cascade from its thread, which cleanup() deletes).
    try {
      await mail.exec("DELETE FROM mail_messages WHERE id LIKE $1", [
        "e2e-%-inset-review-m1",
      ]);
    } finally {
      await mail.cleanup();
      console.log("removed the seeded mail fixture");
    }
  }
}
