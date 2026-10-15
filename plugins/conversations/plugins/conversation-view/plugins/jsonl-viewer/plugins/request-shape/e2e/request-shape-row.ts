/**
 * Verifies Claude Code's api-request-shape lines render as tool-set rows
 * ("Tools and system prompt", then "Tools changed" …) rather than the
 * unknown-event raw-JSON card, and snaps the first and the last row opened.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/request-shape/e2e/request-shape-row.ts --conv <id> [--out /tmp/request-shape]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const convId = arg("conv") ?? "conv-1792063757-dphzny";
const out = arg("out") ?? "/tmp/request-shape";
const ROW = '[data-event-key^="request-shape:"]';

await withBrowser(async (h) => {
  const r = report("request shapes render as tool-set rows");
  const { page } = await h.session({ viewport: { width: 1280, height: 1000 } });

  await boot(page, pathUrl(`/agents/c/${convId}`), {
    marker: "[data-event-key]",
    settleMs: 2500,
  });

  r.ok(
    "no api-request-shape falls back to the unknown card",
    (await page
      .locator('[data-event-key^="unknown:"]')
      .filter({ hasText: "api-request-shape" })
      .count()) === 0,
    "an unknown row still carries an api-request-shape payload",
  );

  const rows = page.locator(ROW);
  const count = await rows.count();
  r.ok(
    "the transcript has a request-shape row",
    count > 0,
    `no ${ROW} row — pick a recent conversation via --conv`,
  );
  if (count === 0) return r.finish();
  r.note(`${count} request-shape row(s)`);

  const picks =
    count > 1
      ? ([
          [0, "first"],
          [count - 1, "last"],
        ] as const)
      : ([[0, "first"]] as const);
  for (const [i, name] of picks) {
    const row = rows.nth(i);
    // Centred: the section's sticky user-message header covers the top edge.
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await row.getByRole("button", { expanded: false }).first().click();
    await page.waitForTimeout(400);
    r.ok(
      `the ${name} row opens onto its tool chips`,
      (await row.getByText(/tools?$/).count()) > 0,
      "no tool count in the opened row",
    );
    await row.screenshot({ path: `${out}-${name}-row.png` });
    r.note(`wrote ${out}-${name}-row.png`);
  }
  await r.finish();
});
