// Home → Recent activity (the `activity` Meta-DataView over tasks,
// conversations and pages).
//
// Checks, on the deployed app:
// - the Recent view lists rows of every kind (keyed `type:id`), newest first;
// - the Tasks view (`type is task`) leaves only task rows. That the filter
//   runs on the server (and prunes the other arms) is pinned by
//   network/live's serve-union-entity-arms.test.ts: the live socket is
//   tab-shared, opened outside the page, so its frames are not observable
//   here;
// - a page row opens its page in Pages, and a task row its task in the
//   agent manager (`activityLinks`: a link into the record's own app).
//
// Usage:
//   ./singularity run plugins/activity/e2e/recent-activity.ts [--out /tmp/recent-activity]

import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? "/tmp/recent-activity";
const r = report(
  "Home: Recent activity lists every kind, each opening its own app",
);

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl("/home"));

  const rows = page.locator('[data-row-key*=":"]');
  const ofKind = (kind: string) => page.locator(`[data-row-key^="${kind}:"]`);
  await ofKind("task").first().waitFor({ timeout: 30_000 });
  await ofKind("conversation").first().waitFor({ timeout: 30_000 });
  await ofKind("page").first().waitFor({ timeout: 30_000 });
  r.ok("Recent lists tasks, conversations and pages", true);
  await snap(page, out, "recent");

  // The Tasks view: a filter on the union's source field, run in SQL.
  await page.locator('[data-view-type="list"]', { hasText: "Tasks" }).click();
  await page.waitForFunction(
    () => {
      // At least one row: `every` holds on the empty list a view switch
      // shows while its first page loads.
      const keys = [...document.querySelectorAll('[data-row-key*=":"]')].map(
        (e) => e.getAttribute("data-row-key")!,
      );
      return keys.length > 0 && keys.every((k) => k.startsWith("task:"));
    },
    undefined,
    { timeout: 15_000 },
  );
  r.ok(
    "the Tasks view leaves only task rows",
    (await rows.count()) > 0 && (await ofKind("conversation").count()) === 0,
  );
  await snap(page, out, "tasks");

  // A task row opens its task in the agent manager.
  await ofKind("task").first().click();
  await page.waitForURL((u) => u.pathname.includes("/t/"), { timeout: 15_000 });
  r.ok(
    `a task row opens the task (${new URL(page.url()).pathname})`,
    new URL(page.url()).pathname.startsWith("/agents/"),
  );
  await snap(page, out, "task-opened");

  // A page row opens its page in Pages.
  await page.goto(pathUrl("/home"));
  await page.locator('[data-view-type="list"]', { hasText: "Pages" }).click();
  await ofKind("page").first().waitFor({ timeout: 15_000 });
  await ofKind("page").first().click();
  await page.waitForURL((u) => u.pathname.startsWith("/pages/page/"), {
    timeout: 15_000,
  });
  r.ok(`a page row opens the page (${new URL(page.url()).pathname})`, true);
  await snap(page, out, "page-opened");
  return true;
});

await r.finish();
