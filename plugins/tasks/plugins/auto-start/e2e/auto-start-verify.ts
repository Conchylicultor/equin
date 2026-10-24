// Verifies an auto-start marker reaches the UI through its point read (the
// `tasks-auto-start:rows` lookup): open an ARMED task's detail and read back
// what its Auto-start select settles on.
//
// A blind screenshot cannot verify this. The point read hydrates
// post-mount, and on a busy backend one tuple's sub-ack can trail its
// subscription by ten seconds or more — so a fixed wait reads "Off", which is
// ALSO the genuine not-armed rendering, and a live marker looks lost. This
// script waits for the control to stop saying Off and reports where it landed.
//
// Usage:
//   ./equin run plugins/tasks/plugins/auto-start/e2e/auto-start-verify.ts \
//     --task <taskId> [--expect "Opus 5"] [--settle 60000] [--headed]
//
// `--task` is required — which task is armed is data this script cannot know:
//   select parent_id, auto_start_model from tasks_ext_auto_start limit 1;

import {
  arg,
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const taskId = requireArg(
  "task",
  "usage: --task <taskId> [--expect <label>] [--settle <ms>]",
);
const expected = arg("expect");
const settleMs = numArg("settle", 60_000);

const SELECT = '[aria-label="Auto-start model"]';
const url = pathUrl(`/agents/tasks/t/${taskId}`);

const r = report("auto-start point read");
console.log(`url: ${url}`);

const { text, pageErrors, consoleErrors } = await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  await page.goto(url);

  // The control mounts only once the Prompt card's description resolves, so
  // wait for the element before reading it.
  await page.waitForSelector(SELECT, { timeout: settleMs });

  // Then wait out the point read's post-mount round-trip.
  const deadline = Date.now() + settleMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = (await page.locator(SELECT).innerText()).trim();
    if (seen && seen !== "Off") break;
    await page.waitForTimeout(500);
  }
  return {
    text: seen,
    pageErrors: captured.pageErrors,
    consoleErrors: captured.consoleErrors,
  };
});

r.note(`select settled on ${JSON.stringify(text)}`);
if (expected) r.eq("auto-start model", text, expected);
else r.ok("auto-start armed", text !== "Off", `got ${JSON.stringify(text)}`);
r.ok("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
r.ok(
  "no console errors",
  consoleErrors.length === 0,
  consoleErrors.join(" | "),
);
await r.finish();
