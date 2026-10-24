// Drives a ConversationRow through the three things the row owns: it opens the
// run in a column beside the surface, it marks itself as the one open, and a
// second click closes that column again.
//
// The surface it drives is the task detail's Attempts card — the case the two
// hand-rolled active-state heuristics used to get WRONG. Reached from the task
// list, its route holds no conversation pane of its own, so the old
// "last entry, but only if there are two" rule answered "nothing is open" and
// the row never lit up.
//
// A task must be named, because only a task that has been worked has runs to
// show and nothing in the app names one generically. Find one with:
//   SELECT a.task_id FROM attempts a JOIN conversations c ON c.attempt_id = a.id
//   GROUP BY a.task_id ORDER BY count(*) DESC LIMIT 1;
//
// Usage:
//   ./equin run plugins/conversations/plugins/conversation-ui/plugins/row/e2e/conversation-row-verify.ts --task <taskId>

import {
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/conversation-row";
const taskId = requireArg(
  "task",
  "conversation-row-verify.ts --task <taskId>   (a task that has been worked; see the header)",
);

await withBrowser(async (h) => {
  const { page } = await h.session({
    colorScheme: "dark",
    viewport: { width: 1600, height: 1000 },
  });
  const r = report("conversation-row");

  await page.goto(pathUrl(`/agents/tasks/t/${taskId}`));
  await page.waitForTimeout(4000);

  // Scope to the Attempts card — `.last()` is the innermost box still holding
  // the heading, i.e. the card itself rather than the whole pane. Inside it a
  // conversation row renders as a <button> named from the conversation's title,
  // carrying `data-focus-ring` (Row nominates its control with it) and
  // `aria-current` while it is the open one.
  const card = page
    .locator("div")
    .filter({ has: page.getByText("Attempts", { exact: true }) })
    .last();
  const row = card.locator("button[data-focus-ring]");
  const count = await row.count();
  r.ok("the task detail shows conversation rows", count > 0, `count=${count}`);
  if (count === 0) return r.finish();

  const first = row.first();
  const name = (await first.innerText()).trim().split("\n")[0];
  r.note(`driving the row named "${name}"`);

  r.ok("no conversation column yet", !page.url().includes("/c/"), page.url());

  await first.click();
  await page.waitForTimeout(2000);
  await snap(page, OUT, "opened");
  r.ok("clicking a row opens its run", page.url().includes("/c/"), page.url());
  r.ok(
    "the row it opened is marked as the open one",
    (await first.getAttribute("aria-current")) === "true",
  );

  await first.click();
  await page.waitForTimeout(2000);
  r.ok(
    "clicking it again closes the column",
    !page.url().includes("/c/"),
    page.url(),
  );
  r.ok(
    "and it stops being marked",
    (await first.getAttribute("aria-current")) === null,
  );

  await r.finish();
});
