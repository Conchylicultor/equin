/**
 * Verifies the investigate action appears on exactly the failed runs in a
 * deployment's History, and that pressing it opens the launch form.
 *
 * The interesting assertion is the NEGATIVE one: the gate is
 * `status === "failed"`, not "not succeeded", so a permanently-`running` row —
 * one whose backend died mid-run — must stay clean too. Counting buttons
 * globally would pass with the gate written either way, so this walks each
 * button back to its own row and reads that row's outcome badge instead.
 *
 * Hover-reveal is opacity + pointer-events, not mount/unmount, so the buttons
 * are in the DOM without simulating hover; the click at the end goes through
 * Playwright's own hover, which is what makes them pressable.
 *
 *   ./equin run plugins/apps/plugins/deploy/plugins/deploy-history/plugins/investigate-failure/e2e/investigate-failure.ts \
 *     --server <serverId> --deployment <deploymentId>
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const INVESTIGATE = '[aria-label="Investigate failure"]';

/**
 * A list row, by the padding token only `Row` applies. There is no data
 * attribute to key on, and the alternative — counting buttons globally — is
 * exactly the assertion this script exists to avoid.
 */
const ROW = '[class*="p-row"]';

const serverId = arg("server") ?? "srv-1784718612584-q17b8x";
const deploymentId = arg("deployment") ?? "dpl-1785501087837-xkt5u5";
const out = arg("out", "/tmp/investigate-failure");

await withBrowser(async (h) => {
  const r = report("deploy history investigate action");
  const { page, captured } = await h.session();

  // The pane's sections carry a device-local collapse state, so a fresh browser
  // profile opens with every one shut. Wait for the pane, then open History.
  await boot(page, pathUrl(`/deploy/server/${serverId}/dep/${deploymentId}`), {
    marker: "text=History",
    settleMs: 2000,
  });
  await page.getByText("History", { exact: true }).first().click();
  // The section is a server-delegated keyset query: wait for a row rather than
  // for the card, or an unloaded ledger reads as an empty one.
  await page.locator(ROW).first().waitFor({ state: "attached" });
  // "All", so the window is every run rather than the Recent view's head.
  const all = page.getByRole("radio", { name: "All", exact: true });
  if ((await all.count()) > 0) await all.first().click();
  await page.waitForTimeout(1500);

  const rows = await page.$$eval(
    ROW,
    (nodes, sel) =>
      nodes
        .map((n) => ({
          text: (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
          buttons: n.querySelectorAll(sel).length,
        }))
        // A History row is one that states an outcome — the `status` field is
        // `primary`, so its badge is the row's first words.
        .filter((row) => /^(Running|Succeeded|Failed)/.test(row.text)),
    INVESTIGATE,
  );

  r.note(`${rows.length} history rows for ${deploymentId}`);
  for (const row of rows) r.note(`  · [${row.buttons}] ${row.text}`);

  const failed = rows.filter((row) => row.text.startsWith("Failed"));
  const other = rows.filter((row) => !row.text.startsWith("Failed"));

  r.ok(
    "at least one failed run is present to assert on",
    failed.length > 0,
    "no failed run in this ledger — pass --deployment for one that has one",
  );
  r.ok(
    "every failed run shows the action exactly once",
    failed.every((row) => row.buttons === 1),
    `button counts: ${failed.map((row) => row.buttons).join("/")}`,
  );
  // Vacuous on a ledger of nothing but failures — which is the honest state of
  // most deployments that have one. It is here so the gate is asserted the day
  // a succeeded or stuck-running run does land in the window.
  if (other.length === 0) {
    r.note(
      "no succeeded or running run in this window — negative case not exercised",
    );
  }
  r.ok(
    "no succeeded or running run shows it",
    other.every((row) => row.buttons === 0),
    `offered on: ${other
      .filter((row) => row.buttons > 0)
      .map((row) => row.text)
      .join(", ")}`,
  );

  // The popover is the action's whole payload: a button that opens nothing is
  // the failure this catches.
  if (failed.length > 0) {
    // Hover the ROW, not the button. The reveal couples opacity with
    // pointer-events, so until the row is hovered the button is not a hit
    // target — and Playwright's actionability check hit-tests without moving
    // the mouse first, so aiming straight at the button retries forever against
    // a row it never hovered. A real pointer crosses the row on its way in.
    const failedRow = page.locator(ROW).filter({ hasText: "Failed" }).first();
    await failedRow.hover();
    await snap(page, out, "hover");
    await failedRow.locator(INVESTIGATE).click();
    // `isVisible()` rather than `waitFor()`: the popover opens on a React state
    // flip in the click's own turn, so there is nothing to wait for — and a
    // `waitFor` here could only report the miss by throwing, which would trade
    // this named assertion for a stack trace.
    const heading = page.getByText("Investigate this failure", { exact: true });
    r.ok(
      "pressing it opens the launch form",
      await heading.isVisible(),
      "no launch form appeared after the click",
    );
    await snap(page, out, "popover");
  }

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );

  await r.finish();
});
