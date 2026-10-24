// Verifies Debug → Background activity end-to-end against the deployed app:
//
// 1. The pane lists the catalog, and a known scheduled job reads its schedule
//    in words — `ip-country.refresh` shows "Mondays 03:40 UTC" (the words come
//    from the one crontab parse graphile's cron item matches by, so this is the
//    whole chain).
// 2. A timer row (kind `timer`, from `defineTimer`) opens its detail pane,
//    which renders its interval trigger and its recent runs.
// 3. A warm-up row (kind `warmup`) opens its detail pane, which renders
//    "After boot".
// 4. A file-watcher row (kind `file-watcher`, from `defineFileWatcher`)
//    renders its file-change trigger and its open instance.
//
// Usage:
//   ./equin run plugins/infra/plugins/background/plugins/catalog/e2e/verify.ts [--headed] [--out /tmp/bg-verify]

import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/bg-verify";
const TIMEOUT_MS = 20_000;

const r = report("background activity — catalog page");

// The list's rows carry no per-row attribute outside manual ordering, so each
// step narrows the list with the search box until the row it asserts on is the
// only match, and finds it by its code name.
await withBrowser(async (h) => {
  const { page } = await h.session();
  const main = page.locator("main").first();

  // ── 1. The list: a scheduled job's schedule in words ─────────────────────
  await boot(page, pathUrl("/debug/background"), {
    marker: 'input[placeholder="Search what runs…"]',
  });
  const search = page.getByPlaceholder("Search what runs…");
  const codeName = (name: string) => page.getByText(name, { exact: true });

  await search.fill("ip-country.refresh");
  await codeName("ip-country.refresh").waitFor({ timeout: TIMEOUT_MS });
  const listText = (await main.innerText()).replace(/\s+/g, " ");
  r.ok(
    "ip-country.refresh reads 'Mondays 03:40 UTC'",
    listText.includes("Mondays 03:40 UTC"),
    listText.slice(0, 400),
  );
  await snap(page, OUT, "list");

  // Timers and warm-ups are listed (their providers registered).
  for (const [group, name] of [
    ["Timers", "jobs.stuck-lock-sweep"],
    ["After boot", "plugin-tree.trees"],
  ] as const) {
    await search.fill(name);
    await codeName(name).waitFor({ timeout: TIMEOUT_MS });
    r.ok(
      `${name} is listed under ${group}`,
      (await main.innerText()).includes(group),
    );
  }

  // ── 2. A timer's detail pane ────────────────────────────────────────────
  await search.fill("jobs.stuck-lock-sweep");
  await codeName("jobs.stuck-lock-sweep").click();
  await page
    .getByRole("heading", { name: /Frees jobs whose worker died mid-run/ })
    .waitFor({ timeout: TIMEOUT_MS });
  r.ok(
    "the timer's detail says when it runs",
    (await page.locator("body").innerText()).includes("Every minute"),
  );
  r.ok(
    "the timer's detail has a Recent runs section",
    await page.getByRole("heading", { name: "Recent runs" }).isVisible(),
  );
  await snap(page, OUT, "timer");

  // ── 3. A warm-up's detail pane ──────────────────────────────────────────
  await page.goto(
    pathUrl("/debug/background/activity/warmup/plugin-tree.trees"),
  );
  const heading = page.getByRole("heading", {
    name: /Pre-builds the plugin trees/,
  });
  await heading.waitFor({ timeout: TIMEOUT_MS });
  r.ok(
    "the warm-up's detail renders its trigger",
    (await page.locator("body").innerText()).includes("After boot"),
  );
  await snap(page, OUT, "warmup");

  // ── 4. A file watcher's detail pane ─────────────────────────────────────
  // config_v2's watcher is started on every backend at boot, so it has one
  // open instance watching the config directory.
  await page.goto(
    pathUrl("/debug/background/activity/file-watcher/config_v2.config-files"),
  );
  await page
    .getByRole("heading", { name: /Watches the config directory/ })
    .waitFor({ timeout: TIMEOUT_MS });
  const watcherText = (await page.locator("body").innerText()).replace(
    /\s+/g,
    " ",
  );
  r.ok(
    "the watcher's detail renders its trigger",
    watcherText.includes("When watched files change"),
    watcherText.slice(0, 600),
  );
  r.ok(
    "the watcher's detail lists its open instance",
    /Open\s*1/.test(watcherText) && watcherText.includes("Watching"),
    watcherText.slice(0, 600),
  );
  await snap(page, OUT, "watcher");
});

await r.finish();
