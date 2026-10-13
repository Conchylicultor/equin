/**
 * The page is never blank while the boot snapshot is pending, failing or stuck.
 *
 * Incident 2026-10-12: a wedged backend never answered
 * `GET /api/resources/boot-snapshot`, and every tab sat on an empty black
 * `#root` for half an hour. App now renders a boot screen from its first commit
 * (`[data-boot-state]`): `waiting` (faded in after a 1s grace), `stuck` once a
 * blocking boot task is past the deadline, `failed` when one rejects.
 *
 *   A. stalled snapshot (returning user) → `waiting` in the first paint,
 *      naming "Boot snapshot"; `stuck` after the deadline; releasing the stall
 *      boots the app by itself.
 *   B. failing snapshot (503) → `failed` at once, the status in the text;
 *      Continue anyway boots the app.
 *   C. normal (warm) reload → the waiting state fades in only if the boot
 *      outlives its 1s grace; a boot inside the grace never shows it.
 *
 *   ./singularity run plugins/infra/plugins/boot-snapshot/e2e/boot-stall.ts [--out /tmp/boot-stall]
 */
import {
  arg,
  pathUrl,
  report,
  snap,
  stallRoute,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const r = report("boot screen while the boot snapshot is stalled / failing");
const out = arg("out", "/tmp/boot-stall");

const SNAPSHOT = "**/api/resources/boot-snapshot*";
const BOOT = "[data-boot-state]";
/** App's BOOT_TASK_DEADLINE_MS (15s) plus slack. */
const DEADLINE_WAIT_MS = 25_000;
/** The boot screen's waiting grace (boot-screen.css). */
const GRACE_MS = 1000;

await withBrowser(async (h) => {
  // ── A. stalled ──────────────────────────────────────────────────────────
  {
    const { page } = await h.session({ label: "stalled" });
    // A returning user, as in the incident: one normal load first fills the
    // HTTP cache and the theme's pre-paint cache (web-core index.html), so the
    // boot screen below wears the user's theme, as it would for them.
    await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });
    await page.locator(BOOT).waitFor({ state: "detached", timeout: 60_000 });
    const stall = await stallRoute(page, SNAPSHOT, { ms: 120_000 });
    const t0 = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(BOOT).waitFor({ state: "attached", timeout: 10_000 });
    r.note(`boot screen attached ${Date.now() - t0}ms after navigation`);
    r.eq(
      "A: stalled → waiting",
      await page.locator(BOOT).getAttribute("data-boot-state"),
      "waiting",
    );
    // Loading the code comes first ("Loading the app…"); on a contended host
    // that alone can outlast the grace. Then the boot tasks name themselves.
    await page
      .locator(BOOT)
      .filter({ hasText: "Boot snapshot" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(GRACE_MS + 500);
    r.eq(
      "A: still waiting (not yet past the deadline)",
      await page.locator(BOOT).getAttribute("data-boot-state"),
      "waiting",
    );
    const waitingText = (await page.locator(BOOT).innerText()).trim();
    r.ok(
      "A: waiting names the server and the task",
      waitingText.includes("Waiting for the server") &&
        waitingText.includes("Boot snapshot"),
      waitingText,
    );
    r.ok(
      "A: waiting shows an elapsed clock",
      /\d+:\d\d/.test(waitingText),
      waitingText,
    );
    await snap(page, out, "a-waiting");

    await page
      .locator('[data-boot-state="stuck"]')
      .waitFor({ state: "visible", timeout: DEADLINE_WAIT_MS });
    const stuckText = await page.locator(BOOT).innerText();
    r.ok(
      "A: stuck names the overdue task, offers Retry and Continue anyway",
      stuckText.includes("Boot snapshot") &&
        stuckText.includes("Retry") &&
        stuckText.includes("Continue anyway"),
      stuckText,
    );
    await snap(page, out, "a-stuck");

    await stall.release();
    await page.locator(BOOT).waitFor({ state: "detached", timeout: 30_000 });
    const rootLen = await page.evaluate(
      () => document.getElementById("root")?.innerHTML.length ?? 0,
    );
    r.ok("A: releasing the stall boots the app by itself", rootLen > 0);
    await page.context().close();
  }

  // ── B. failing ──────────────────────────────────────────────────────────
  {
    const { page } = await h.session({ label: "failing", capture: false });
    let answeredAt = 0;
    await page.route(SNAPSHOT, async (route) => {
      answeredAt = Date.now();
      await route.fulfill({ status: 503, body: "wedged (e2e)" });
    });
    await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });
    await page
      .locator('[data-boot-state="failed"]')
      .waitFor({ state: "visible", timeout: 60_000 });
    // From the 503 reaching the page, not from navigation: code loading is
    // the host's speed, not what this asserts.
    const ms = Date.now() - answeredAt;
    r.ok("B: failing → failed at once", ms < 2000, `${ms}ms after the 503`);
    const text = await page.locator(BOOT).innerText();
    r.ok(
      "B: failed names the task and the status",
      text.includes("Boot snapshot") && text.includes("503"),
      text,
    );
    await snap(page, out, "b-failed");
    await page.getByRole("button", { name: "Continue anyway" }).click();
    await page.locator(BOOT).waitFor({ state: "detached", timeout: 15_000 });
    r.ok("B: Continue anyway boots the app", true);
    await page.context().close();
  }

  // ── C. normal ───────────────────────────────────────────────────────────
  {
    const { page } = await h.session({ label: "normal" });
    // Whether the waiting contents ever showed: their fade-in animation starts
    // only once the grace delay has elapsed, so `animationstart` IS "became
    // visible". Also how long the boot screen lived, for the transcript.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __bootScreenShown?: boolean;
        __bootScreenMs?: number;
      };
      w.__bootScreenShown = false;
      document.addEventListener("animationstart", (e) => {
        if (e.animationName === "boot-screen-fade-in")
          w.__bootScreenShown = true;
      });
      let addedAt: number | null = null;
      new MutationObserver(() => {
        const present = document.querySelector("[data-boot-state]") !== null;
        if (present && addedAt === null) addedAt = performance.now();
        if (!present && addedAt !== null && w.__bootScreenMs === undefined) {
          w.__bootScreenMs = performance.now() - addedAt;
        }
      }).observe(document, { childList: true, subtree: true });
    });
    // The first load fills the HTTP cache with the app's code; the reload is
    // the boot a returning user sees.
    await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });
    await page.locator(BOOT).waitFor({ state: "detached", timeout: 30_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(BOOT).waitFor({ state: "detached", timeout: 30_000 });
    const { shown, lived } = await page.evaluate(() => {
      const w = window as unknown as {
        __bootScreenShown?: boolean;
        __bootScreenMs?: number;
      };
      return { shown: w.__bootScreenShown, lived: w.__bootScreenMs };
    });
    r.note(
      `warm reload: boot screen lived ${lived === undefined ? "?" : Math.round(lived)}ms`,
    );
    // The waiting state may show only on a boot that outlived the grace (a
    // contended host makes even a warm boot slow — that is a slow boot, and
    // saying so is the point). A boot inside the grace must never show it.
    r.ok(
      "C: the waiting state shows only on a boot slower than the grace",
      lived !== undefined && shown === lived > GRACE_MS,
      `shown=${String(shown)} lived=${lived === undefined ? "?" : Math.round(lived)}ms`,
    );
  }

  await r.finish();
});
