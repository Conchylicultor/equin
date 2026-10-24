// Drives the events-test surface end to end: subscribe (a filtered one-shot plus
// a match-any recurring), emit for two userIds, sweep by action config, then read
// the final trigger/log state back over the API.
//
// Mutates server state — it resets and deletes the existing events-test triggers
// before it starts.
//
// Usage:
//   ./equin run plugins/infra/plugins/events-test/e2e/events-test-flow.ts [--url http://<worktree>.localhost:9000]

import {
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const URL = pathUrl("/events-test");
const OUT = "/tmp/events-test-flow";

interface TriggersResponse {
  rows: { id: string }[];
}

interface LogResponse {
  entries: { label: string; payload: { userId: string; message: unknown } }[];
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  // Clear any prior state
  await page.request.post(pathUrl("/api/events-test/reset"));
  const existing = (await page.request
    .get(pathUrl("/api/events-test/triggers"))
    .then((r) => r.json())) as TriggersResponse;
  for (const row of existing.rows) {
    await page.request.delete(pathUrl(`/api/events-test/trigger/${row.id}`));
  }

  await page.goto(URL);
  await page.waitForTimeout(1200);
  await snap(page, OUT, "01-initial");

  // Fill Subscribe form — filtered subscription for userId=alice with oneShot
  const subSection = page
    .locator("section")
    .filter({ hasText: "Subscribe" })
    .first();
  await subSection.getByPlaceholder("empty = match any").fill("alice");
  await subSection.getByPlaceholder("required").fill("alice-oneshot");
  await subSection.getByRole("button", { name: /Subscribe/i }).click();
  await page.waitForTimeout(600);

  // Add a second, match-any recurring subscription
  await subSection.getByPlaceholder("empty = match any").fill("");
  await subSection.getByPlaceholder("required").fill("any-recurring");
  await subSection.getByText("oneShot (delete row after fire)").click();
  await subSection.getByRole("button", { name: /Subscribe/i }).click();
  await page.waitForTimeout(600);

  await snap(page, OUT, "02-two-subscribed");

  // Emit for userId=alice → both triggers should fire; alice-oneshot deletes
  const emitSection = page
    .locator("section")
    .filter({ hasText: "Emit" })
    .first();
  await emitSection.getByPlaceholder("required").fill("alice");
  await emitSection.getByPlaceholder(/defaults to/).fill("first ping");
  await emitSection.getByRole("button", { name: /Emit pinged/i }).click();
  await page.waitForTimeout(800);
  await snap(page, OUT, "03-after-emit-alice");

  // Emit for userId=bob → only the recurring match-any should fire
  await emitSection.getByPlaceholder("required").fill("bob");
  await emitSection.getByPlaceholder(/defaults to/).fill("second ping");
  await emitSection.getByRole("button", { name: /Emit pinged/i }).click();
  await page.waitForTimeout(800);
  await snap(page, OUT, "04-after-emit-bob");

  // Sweep all triggers with label=any-recurring via the Delete-by-config form
  const sweepSection = page
    .locator("section")
    .filter({ hasText: "Delete triggers by action config" })
    .first();
  await sweepSection.getByPlaceholder(/JSONB/).fill("any-recurring");
  await sweepSection.getByRole("button", { name: /Sweep/i }).click();
  await page.waitForTimeout(800);
  await snap(page, OUT, "05-after-sweep");

  // Assert final state via API
  const triggers = (await page.request
    .get(pathUrl("/api/events-test/triggers"))
    .then((r) => r.json())) as TriggersResponse;
  const log = (await page.request
    .get(pathUrl("/api/events-test/log"))
    .then((r) => r.json())) as LogResponse;
  console.log(`final triggers: ${triggers.rows.length} (expect 0)`);
  console.log(
    `final log entries: ${log.entries.length} (expect 3: alice/alice-oneshot, alice/any-recurring, bob/any-recurring)`,
  );
  for (const e of log.entries) {
    console.log(
      ` - ${e.label} userId=${e.payload.userId} msg=${JSON.stringify(e.payload.message)}`,
    );
  }
});
