// Screenshot the health report's Job queue row, expanded.
//
// Opens the app, clicks the health dot, expands the "Job queue" row and writes
// `<out>-report.png`. Prints the dot's state and verdict so a run reads as a
// result, not just an image.
//
// `--saturate` first drives the queue into a saturated state through the
// events-test harness (`POST /api/events-test/queue-saturate`): one more
// `minutes` sleeper than that class has slots, plus one job that dead-letters.
// `--backdate-ms` backdates the sleepers so the waiting one is already past a
// threshold (660000 → amber, 3600000 → red); `--settle-ms` waits for the
// sleepers to start before capturing.
//
// Usage:
//   ./equin run plugins/debug/plugins/queue-health/e2e/queue-row.ts --out /tmp/qh
//   ./equin run plugins/debug/plugins/queue-health/e2e/queue-row.ts \
//     --saturate --backdate-ms 660000 --out /tmp/qh-amber

import {
  agentFetch,
  arg,
  flag,
  numArg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? "/tmp/queue-row";
const saturate = flag("saturate");
const backdateMs = numArg("backdate-ms", 0);
const settleMs = numArg("settle-ms", 4000);
const colorScheme = arg("color-scheme");

if (saturate) {
  const res = await agentFetch("/api/events-test/queue-saturate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backdateMs }),
  });
  if (!res.ok) {
    throw new Error(
      `queue-saturate failed (${res.status}): ${await res.text()}`,
    );
  }
  console.log(`saturate: ${await res.text()}`);
}

const ok = await withBrowser(async (h) => {
  const { page } = await h.session(
    colorScheme === "dark" || colorScheme === "light" ? { colorScheme } : {},
  );
  await page.goto(pathUrl("/"));

  const dot = page.locator("[data-health]").first();
  await dot.waitFor({ state: "visible" });
  if (saturate) await page.waitForTimeout(settleMs);

  await dot.click();
  const row = page.locator("[aria-expanded]", { hasText: "Job queue" }).first();
  await row.waitFor({ state: "visible" });
  await row.click();
  await page.waitForTimeout(500);

  console.log(
    `dot: state=${await dot.getAttribute("data-health")} verdict="${await dot.getAttribute("aria-label")}"`,
  );
  console.log(`row: ${(await row.innerText()).replace(/\s+/g, " ").trim()}`);
  const shot = await snap(page, out, "report");

  // `--watch-s N` keeps this page open (no reload) and logs every verdict the
  // dot shows over the next N seconds: the check that the row is pushed, not
  // read once. A test observing the page may sample; the app itself does not.
  const watchS = numArg("watch-s", 0);
  let last = await dot.getAttribute("aria-label");
  for (let t = 0; t < watchS; t += 5) {
    await page.waitForTimeout(5000);
    const now = await dot.getAttribute("aria-label");
    if (now !== last) {
      console.log(`+${t + 5}s dot: "${now}"`);
      last = now;
    }
  }
  if (watchS > 0) await snap(page, out, "after-watch");
  return shot.ok;
});

process.exit(ok ? 0 : 1);
