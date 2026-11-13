// Before / after captures of the pane header edge: every kind of pane (detail,
// full, DataView list and table, document and not, per app, in the solo and
// desktop surface modes), so a pair taken around a change to where a pane's
// header and body start differs only by that change.
//
//   ./equin run plugins/primitives/plugins/css/plugins/rail/e2e/pane-header-review.ts \
//     --out "$EQUIN_SCRATCH/header-review" --suffix before [--only a,b] [--set hj]
//
// Writes `<out>/<surface>-<suffix>.png` and prints, per surface, one
// `measure <surface> […]` line — for EVERY pane header on screen, from that
// pane's own left edge: the header's start padding, its leading glyph, its
// title's first letter, and the pane body's first drawn thing (text, or a box
// with a border or fill) — then `ok` / `FAILED <why>` (the run goes on).
//
// `--set hj` captures the cross-pane header jump: the same screen slot showing
// a document pane (`-doc`) and a neighbouring plain one (`-plain`).
//
// Onboarding never sits on a capture (tips answered as they show, a snap is
// refused while any hints-stage piece is up), toasts are cleared before each
// snap. Page-backed surfaces open on a blank page created through the app in
// THIS checkout's database; the mail reader opens a seeded message. Both are
// deleted at the end.

import type { Page } from "playwright";
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
import {
  openThreadFixture,
  type ThreadFixture,
} from "@plugins/apps/plugins/mail/plugins/threads/e2e";

interface Fixtures {
  mailMessageId: string;
}

interface Surface {
  name: string;
  /** A route, `blank-page` (a page created for the run), or a function of the fixtures. */
  path: string | ((f: Fixtures) => string);
}

const SURFACES: readonly Surface[] = [
  // ── Debug: detail and full panes, document and not, list and table ──
  { name: "detail-doc", path: "/debug/reports/rep/report-1794574740-fezcd2" },
  { name: "detail-plain", path: "/debug/build/r/build-1794488888-ghzpsm" },
  { name: "full-doc", path: "/debug/heap" },
  { name: "full-list", path: "/debug/reports" },
  { name: "full-table", path: "/debug/boot-profile" },
  { name: "queue", path: "/debug/queue" },
  // ── Agent manager ───────────────────────────────────────────────────
  { name: "am-tasks", path: "/agents/tasks" },
  { name: "am-task-detail", path: "/agents/tasks/t/task-1794571510-eir76z" },
  { name: "am-conversation", path: "/agents/c/conv-1777333537-usf7" },
  { name: "am-summary", path: "/agents/c/conv-1777333537-usf7/summary" },
  { name: "am-workflow-node", path: "/agents/workflow-node/toolu_x/n1" },
  // ── Settings ────────────────────────────────────────────────────────
  {
    name: "settings-config",
    path: "/settings/config/cd/apps%252Fchord%252Fpiano%252Fconfig.jsonc",
  },
  { name: "settings-account", path: "/settings/accounts/account/google" },
  // ── Apps ────────────────────────────────────────────────────────────
  { name: "pages-list", path: "/pages" },
  { name: "pages-page", path: "blank-page" },
  { name: "places", path: "/places" },
  { name: "mail-inbox", path: "/mail" },
  { name: "mail-message", path: (f) => `/mail/search/m/${f.mailMessageId}` },
  { name: "sonata", path: "/sonata" },
  { name: "studio-contributions", path: "/studio/contributions" },
  { name: "studio-table", path: "/studio/t/build/build_runs" },
  { name: "studio-compare", path: "/studio/compositions/compare" },
  { name: "prototypes", path: "/prototypes" },
  // The prototype detail: its header is a floating card (`header="card"`).
  {
    name: "prototype-detail",
    path: "/prototypes/proto/proto-1794490586-hbrirf",
  },
  // Files: the folder browser, then a file previewed beside it.
  {
    name: "files-browse",
    path: "/files/browse/%2Fusr%2Fshare",
  },
  {
    name: "files-preview",
    path: "/files/browse/%2Fusr%2Fshare%2Fdict/preview/README",
  },
  // ── Desktop surface mode (the rest are solo, the boot mode) ─────────
  { name: "desktop-reports", path: "/desktop/debug/reports" },
  {
    name: "desktop-report-detail",
    path: "/desktop/debug/reports/rep/report-1794574740-fezcd2",
  },
];

/** The cross-pane header jump: one screen slot, a document pane then a plain one. */
const HEADER_JUMP_SURFACES: readonly Surface[] = [
  {
    name: "hj-detail-doc",
    path: "/debug/reports/rep/report-1794574740-fezcd2",
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

/**
 * Every visible pane header with its pane, measured from the pane's own left
 * edge: `pad` (the header's start padding), `glyph` (a leading icon control's
 * glyph, when the header starts with one), `title` (the title's first
 * letter), `body` (the body's leftmost drawn thing below the header) and
 * `band` (the first `rail-follow` band's padding — a DataView's toolbar and
 * rows), plus `x` (the pane's screen left, to place the numbers on a shot).
 */
async function measureHeaders(
  page: Page,
): Promise<readonly Record<string, number | string>[]> {
  return page.evaluate((): Record<string, number | string>[] => {
    const textLeft = (root: Element): number | null => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode as Text;
        if (!t.textContent?.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(t);
        const b = r.getBoundingClientRect();
        if (b.width > 0) return b.left;
      }
      return null;
    };
    const out: Record<string, number | string>[] = [];
    const headers = [
      ...document.querySelectorAll<HTMLElement>('[data-part="pane.header"]'),
    ].filter((h) => h.getBoundingClientRect().width > 0);
    for (const header of headers) {
      const pane = header.parentElement?.parentElement;
      if (!pane) continue;
      const pr = pane.getBoundingClientRect();
      const hr = header.getBoundingClientRect();
      const title = header.querySelector('[data-part="pane.title"]');
      const tl = title ? textLeft(title) : null;
      let glyph = -1;
      const firstButton = header.querySelector("button");
      const svg = firstButton?.querySelector("svg");
      if (
        firstButton &&
        svg &&
        title &&
        svg.getBoundingClientRect().width > 0 &&
        firstButton.getBoundingClientRect().right <=
          title.getBoundingClientRect().left
      ) {
        glyph = Math.round(svg.getBoundingClientRect().left - pr.left);
      }
      let body = Infinity;
      const take = (r: DOMRect): void => {
        if (r.width === 0 || r.height === 0 || r.top < hr.bottom) return;
        if (r.top > window.innerHeight || r.left < pr.left - 1) return;
        if (r.left > pr.right) return;
        body = Math.min(body, r.left);
      };
      const w = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode as Text;
        if (!t.textContent?.trim() || header.contains(t)) continue;
        const r = document.createRange();
        r.selectNodeContents(t);
        take(r.getBoundingClientRect());
      }
      for (const el of pane.querySelectorAll<HTMLElement>("*")) {
        if (header.contains(el)) continue;
        const cs = getComputedStyle(el);
        const drawn =
          parseFloat(cs.borderLeftWidth) > 0 ||
          (cs.backgroundColor !== "rgba(0, 0, 0, 0)" &&
            cs.backgroundColor !== "transparent");
        const r = el.getBoundingClientRect();
        if (drawn && r.width < pr.width - 1) take(r);
      }
      const band = pane.querySelector<HTMLElement>(".rail-follow");
      out.push({
        x: Math.round(pr.left),
        w: Math.round(pr.width),
        title: title?.textContent?.trim().slice(0, 32) ?? "",
        pad: Math.round(parseFloat(getComputedStyle(header).paddingLeft)),
        glyph,
        titleLeft: tl === null ? -1 : Math.round(tl - pr.left),
        body: body === Infinity ? -1 : Math.round(body - pr.left),
        band: band
          ? Math.round(parseFloat(getComputedStyle(band).paddingLeft))
          : -1,
      });
    }
    return out;
  });
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
const surfaces = arg("set") === "hj" ? HEADER_JUMP_SURFACES : SURFACES;
const wanted = (s: Surface): boolean => !only || only.includes(s.name);

let mail: ThreadFixture | null = null;
const createdPages: string[] = [];
try {
  let fixtures: Fixtures = { mailMessageId: "" };
  if (surfaces.some((s) => wanted(s) && typeof s.path === "function")) {
    mail = await openThreadFixture();
    const thread = await mail.seed({
      name: "header-review",
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
        "A seeded message for the header review",
        "Hi,\n\nHere are the notes from Tuesday's planning session. The three priorities for the quarter are the onboarding flow, the sync reliability work and the new reporting view.\n\nThanks,\nAda",
      ],
    );
    fixtures = { mailMessageId: messageId };
  }

  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
    });
    await answerTipsAsTheyShow(page);
    for (const s of surfaces) {
      if (!wanted(s)) continue;
      let failed: string | null = null;
      try {
        if (s.path === "blank-page") {
          const doc = await openBlankPage(page, { settleMs: 2000 });
          createdPages.push(doc.pageId);
        } else {
          const path = typeof s.path === "string" ? s.path : s.path(fixtures);
          await page.goto(pathUrl(path), { waitUntil: "domcontentloaded" });
        }
        await waitForNetworkIdle(page);
        await waitForNotBusy(page, { timeoutMs: ELEMENT_TIMEOUT_MS });
        await page.waitForTimeout(2500);
        await clearToasts(page);
        failed = await clearHints(page);
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
      }
      if (failed !== null) {
        console.log(`${s.name}: FAILED ${failed}`);
        process.exitCode = 1;
        continue;
      }
      console.log(
        `measure ${s.name} ${JSON.stringify(await measureHeaders(page))}`,
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
  for (const id of createdPages) {
    const res = await agentFetch(`/api/blocks/${id}`, { method: "DELETE" });
    console.log(`removed fixture page ${id}: ${res.status}`);
  }
  if (mail !== null) {
    try {
      await mail.exec("DELETE FROM mail_messages WHERE id LIKE $1", [
        "e2e-%-header-review-m1",
      ]);
    } finally {
      await mail.cleanup();
      console.log("removed the seeded mail fixture");
    }
  }
}
