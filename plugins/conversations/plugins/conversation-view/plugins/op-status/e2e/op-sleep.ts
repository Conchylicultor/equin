/**
 * An op the machine slept through reads as asleep — never as work — on the
 * op-status banner and the op detail (plan:
 * research/2026-10-08-global-op-sleep-accounting.md, "Verification" 3).
 *
 * A synthetic op (`../scripts/synthetic-op.ts run-asleep`) writes a build in
 * THIS checkout's namespace whose events carry sleep stamps from a fake boot:
 * requested ~2h10 ago, granted a minute later, then a 2 h nap (woken 5 min
 * before its next event), then parked on the host grant for the last 30 s.
 *
 *  1. In flight: the banner's row tooltip for the build reads "worked" ≈ 10
 *     min (the nap excluded) and "asleep 2:00:00".
 *  2. The expanded list's Asleep column is hidden by default; View options →
 *     View settings → Properties reveals it, showing 2:00:00 on the build's
 *     row (then "Show all fields" restores the default view, hiding it again).
 *  3. Completed: the op detail at /debug/profiling/op-profile/<opId> shows the
 *     Asleep stat (2h 0m), Work far below the total, and one hatched overlay
 *     titled "Asleep 2h 0m" (exact: the wake fell inside the gap).
 *
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/op-status/e2e/op-sleep.ts \
 *     --conv <a conversation whose worktree is this checkout> [--out /tmp/op-sleep]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  requireArg,
  snap,
  targetNamespace,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  BANNER,
  LIVE_TIMEOUT_MS,
  closeSynthetic,
  startSynthetic,
  waitBanner,
  type Synthetic,
} from "./synthetic";

const USAGE = "op-sleep.ts --conv <conversationId> [--out <prefix>]";
// A contended host: first paint has been seen past 60 s.
const NAV_TIMEOUT_MS = 180_000;
const ASLEEP_MS = 2 * 60 * 60_000;
// formatElapsed (banner) and formatDuration (op detail) of ASLEEP_MS.
const ASLEEP_CLOCK = "2:00:00";
const ASLEEP_DURATION = "2h 0m";
// The op worked ~10 min around its nap; anything near the 2h10 elapsed means
// the nap was counted as work.
const MAX_WORKED_S = 15 * 60;

const ACTIVE_ROW =
  'button[aria-current="true"]:has([data-ui-owner^="ConversationItem@"])';
// The visible tooltip body (the role="tooltip" node is a visually-hidden copy
// for screen readers).
const TOOLTIP = '[data-slot="tooltip-content"]:visible';

/** `m:ss` / `h:mm:ss` (formatElapsed) → seconds; NaN when it is not a clock. */
function clockSeconds(clock: string): number {
  const parts = clock.split(":").map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * The build's row tooltip: hover each "this conversation" title (the build and
 * this e2e run share the namespace) and keep the one whose state line is the
 * build's.
 */
async function buildTooltip(page: Page): Promise<string> {
  const titles = page.locator(BANNER).getByText("this conversation", {
    exact: true,
  });
  const n = await titles.count();
  for (let i = 0; i < n; i++) {
    await titles.nth(i).hover();
    const tip = page.locator(TOOLTIP).first();
    const shown = await waitFor(
      async () => ((await tip.count()) > 0 ? await tip.innerText() : ""),
      (t) => t.includes("waited"),
      { timeoutMs: 5_000 },
    );
    if (shown.value.startsWith("Build")) return shown.value;
    await page.mouse.move(0, 0);
  }
  return "";
}

/** The "Asleep" visibility checkbox in the banner list's Properties. */
async function asleepToggle(page: Page): Promise<Locator> {
  // The options trigger is hover-revealed (pointer-events off at rest), so
  // point at the list first, as a user does.
  await page.locator(BANNER).hover();
  await page
    .locator(BANNER)
    .getByRole("button", { name: "View options" })
    .click();
  const toggle = page.getByRole("checkbox", { name: "Asleep" });
  // The fold's root page lists the controls; Properties sits on View settings.
  if (!(await toggle.isVisible()))
    await page.getByText("View settings", { exact: true }).click();
  await toggle.waitFor({ state: "visible", timeout: 10_000 });
  return toggle;
}

/**
 * Close the options panel. Escape pops a pushed page (View settings) back to
 * the root first, so press it until the panel is gone.
 */
async function closeOptions(page: Page): Promise<void> {
  const panel = page.getByRole("dialog");
  for (let i = 0; i < 3 && (await panel.count()) > 0; i++)
    await page.keyboard.press("Escape");
  await panel.first().waitFor({ state: "detached", timeout: 5_000 });
}

async function bannerHasAsleepColumn(page: Page): Promise<boolean> {
  return /asleep/i.test(await page.locator(BANNER).innerText());
}

await withBrowser(async (h) => {
  const r = report("op-status: a nap is asleep, never work");
  const convId = requireArg("conv", USAGE);
  const out = arg("out") ?? "/tmp/op-sleep";
  const slug = targetNamespace();
  const dir = mkdtempSync(join(tmpdir(), "op-sleep-e2e-"));
  const started: Synthetic[] = [];
  let revealed = false;

  const { page } = await h.session({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  try {
    await page.goto(pathUrl(`/agents/c/${convId}`), {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await page.locator(ACTIVE_ROW).first().waitFor({ state: "visible" });
    r.note(`namespace ${slug}, conversation ${convId}`);

    // ── 1. in flight: the tooltip's "worked" excludes the nap ────────────────
    const op = startSynthetic(dir, slug, "asleep", "run-asleep", [
      "--asleep-ms",
      String(ASLEEP_MS),
    ]);
    started.push(op);
    r.ok("synthetic asleep op written", await op.step(0));
    r.note(`synthetic op ${op.opId}`);
    const parked = await waitBanner(page, (t) => t.includes("Build —"));
    r.ok(
      "banner shows the build",
      parked.ok,
      `banner text: ${JSON.stringify(parked.value)}`,
    );

    // Expand the card: the list (and its options) render only while open.
    await page
      .locator(BANNER)
      .locator('button[aria-expanded="false"]')
      .first()
      .click();
    const tooltip = await buildTooltip(page);
    const worked = /worked (\S+)/.exec(tooltip)?.[1] ?? "";
    const asleep = /asleep (\S+)/.exec(tooltip)?.[1] ?? "";
    r.ok(
      `tooltip: asleep ${ASLEEP_CLOCK}`,
      asleep === ASLEEP_CLOCK,
      `tooltip: ${JSON.stringify(tooltip)}`,
    );
    r.ok(
      `tooltip: worked under ${MAX_WORKED_S / 60} min (the nap is not work)`,
      clockSeconds(worked) < MAX_WORKED_S,
      `tooltip: ${JSON.stringify(tooltip)}`,
    );
    await page.mouse.move(0, 0);
    await snap(page, out, "1-in-flight");

    // ── 2. the Asleep column: hidden by default, revealable ──────────────────
    r.ok(
      "Asleep column hidden by default",
      !(await bannerHasAsleepColumn(page)),
      `banner text: ${JSON.stringify(await page.locator(BANNER).innerText())}`,
    );
    const toggle = await asleepToggle(page);
    r.ok(
      "Properties lists Asleep, unchecked",
      (await toggle.getAttribute("aria-checked")) === "false",
    );
    await toggle.click();
    revealed = true;
    await closeOptions(page);
    const shown = await waitFor(
      () => page.locator(BANNER).innerText(),
      (t) => /asleep/i.test(t) && t.includes(ASLEEP_CLOCK),
      { timeoutMs: LIVE_TIMEOUT_MS },
    );
    r.ok(
      `revealed: the asleep column shows ${ASLEEP_CLOCK}`,
      shown.ok,
      `banner text: ${JSON.stringify(shown.value)}`,
    );
    await snap(page, out, "2-asleep-column");
    // Restore the user's view: the column choice persists per view, and
    // "Show all fields" puts it back on the schema default (Asleep hidden).
    await asleepToggle(page);
    await page.getByText("Show all fields", { exact: true }).click();
    revealed = false;
    await closeOptions(page);
    r.ok(
      "back to the default columns (the user's view restored)",
      (
        await waitFor(
          () => bannerHasAsleepColumn(page),
          (has) => !has,
          { timeoutMs: 10_000 },
        )
      ).ok,
    );

    // ── 3. completed: the op detail's Asleep stat and hatched overlay ────────
    op.advance(1);
    r.ok("synthetic op completed and released", await op.step(1));
    await op.exited;
    await page.goto(pathUrl(`/debug/profiling/op-profile/${op.opId}`), {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    // Scoped to the op detail itself: the Profiling pane beside it draws its own
    // Gantts (the same op, hatched, included) and span details.
    // Every element the view draws carries its owner; the first is its root.
    const pane = page.locator('[data-ui-owner^="OpDetailView@"]').first();
    const detail = await waitFor(
      async () => ((await pane.count()) > 0 ? await pane.innerText() : ""),
      (t) => t.includes("e2e-synthetic") && t.includes("Success"),
      { timeoutMs: LIVE_TIMEOUT_MS },
    );
    r.ok(
      "detail: the op closed as Success",
      detail.ok,
      `detail pane: ${JSON.stringify(detail.value.slice(0, 400))}`,
    );
    // Stat labels are uppercased by CSS, which innerText reflects.
    const stat = (label: string) =>
      new RegExp(`${label}\\s+([^\\n]+)`, "i").exec(detail.value)?.[1]?.trim();
    r.ok(
      `detail: Asleep stat ${ASLEEP_DURATION}`,
      stat("Asleep") === ASLEEP_DURATION,
      `Asleep stat: ${JSON.stringify(stat("Asleep"))}`,
    );
    const work = stat("Work") ?? "";
    r.ok(
      "detail: Work is minutes, not hours (the nap is not work)",
      work !== "" && !work.includes("h"),
      `Work stat: ${JSON.stringify(work)}, Total: ${JSON.stringify(stat("Total"))}`,
    );
    const overlay = pane.locator(`[title^="Asleep"]`);
    r.ok(
      "detail: one Asleep overlay on the timeline",
      (await overlay.count()) === 1,
      `overlays: ${await overlay.count()}`,
    );
    r.ok(
      `detail: the overlay reads "Asleep ${ASLEEP_DURATION}" (exact position)`,
      (await overlay.first().getAttribute("title")) ===
        `Asleep ${ASLEEP_DURATION}`,
      `title: ${JSON.stringify(await overlay.first().getAttribute("title"))}`,
    );
    const hatch = await overlay
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    r.ok(
      "detail: the overlay is hatched",
      hatch.includes("repeating-linear-gradient"),
      `background-image: ${hatch}`,
    );
    await snap(page, out, "3-detail");
  } finally {
    if (revealed) r.note("left the Asleep column revealed after a failure");
    // Never leave a synthetic op parked (or its row open) behind a failure.
    for (const s of started) {
      s.kill(); // a no-op on an exited helper
      await s.exited;
      await closeSynthetic(s.opId);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  await r.finish();
});
