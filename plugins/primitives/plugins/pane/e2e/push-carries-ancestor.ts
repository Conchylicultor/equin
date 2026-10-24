// Scripted end-to-end check that a RELATIVE open carries the ancestor params
// the caller supplied — the runtime half of "an open never discards a param the
// caller supplied".
//
// `openPane(target, params, { mode: "push" })` takes the target route's CHAINED
// param set, and tsc requires every one of them. The push path used to build the
// target's slot from `extractOwnParams` alone, so an ancestor's `:param` was
// accepted at the call site and then dropped — leaving the target in a route
// without its declared ancestor, a URL missing that ancestor's segment, and a
// pane whose Expand re-rooted into `buildRouteUrl` and threw AFTER `setRoute`
// had already committed. Which of the two happened depended only on WHERE the
// clicked row was rendered: from global chrome (no caller pane) the params were
// honoured, from inside a pane they were not.
//
// The one live instance is a deploy row. `deploymentDetailPane` chains under
// `server/:serverId`, and the merged runs list renders in three places — the
// build button's popover (global chrome), the build pane, and the backup pane.
// This drives the BUILD PANE, i.e. the path that used to drop the id.
//
// Two assertions, and the second is why this is not just "the URL looks right":
// the paramful ancestor (`deploy-server-detail`) must be materialized, and the
// PARAMLESS one (`deploy-servers`, the app index) must NOT — a relative open
// inserts only ancestors that carry something, or every task chip would drag the
// whole tasks tree in beside it.
//
// Manual, self-contained — NOT wired into any check (tests are manual here):
//
//   ./equin run plugins/primitives/plugins/pane/e2e/push-carries-ancestor.ts \
//     [--url <deploy>] [--wait <ms>]
//
// Exit 0 = pass; exit 1 = a failing assertion (with a printed reason).
import {
  ELEMENT_TIMEOUT_MS,
  numArg,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const waitMs = numArg("wait", ELEMENT_TIMEOUT_MS);

/**
 * A deploy row's label is field-driven — "<deployment> on <host>" — not the
 * arm's "Deploy" kind label, so it is matched by shape rather than by a string
 * this script could hardcode. An install with no deploy run has nothing to
 * click, which is reported as a FAILURE rather than skipped: a verification that
 * silently passes having verified nothing is worse than one that says it could
 * not run.
 */
const DEPLOY_ROW = / on \d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const r = report("push carries the caller's ancestor params");

await withBrowser(async (h) => {
  const { page } = await h.session();

  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(pathUrl("/debug/build"), {
    waitUntil: "domcontentloaded",
    timeout: waitMs,
  });

  // `data-pane-id` is stamped by `PaneBox`, the single sanctioned way to paint a
  // pane, so its presence IS "a pane rendered here" — the same read the
  // app-index sweep makes.
  const panesNow = (): Promise<(string | null)[]> =>
    page.$$eval("[data-pane-id]", (els) =>
      els.map((e) => e.getAttribute("data-pane-id")),
    );

  const onBuildPane = await waitFor(panesNow, (ids) => ids.includes("build"), {
    timeoutMs: waitMs,
  });
  r.ok(
    "the build pane is the caller",
    onBuildPane.ok,
    onBuildPane.ok
      ? undefined
      : `panes present: ${onBuildPane.value.join(", ") || "(none)"}`,
  );
  if (!onBuildPane.ok) return;

  const rows = page.getByText(DEPLOY_ROW);
  const count = await rows.count();
  if (count === 0) {
    const seen = await page.$$eval(
      "[data-pane-id] li, [data-pane-id] [role=row]",
      (els) =>
        els.slice(0, 8).map((e) => String(e.textContent).trim().slice(0, 60)),
    );
    r.fail(
      "a deploy row is present to click",
      `no row matched ${String(DEPLOY_ROW)} — this install has no deploy run, so the ` +
        `push path could not be exercised. Rows seen: ${seen.join(" | ") || "(none)"}`,
    );
    return;
  }

  const label = (await rows.first().textContent())?.trim() ?? "";
  await rows.first().click();

  const settled = await waitFor(
    panesNow,
    (ids) => ids.includes("deploy-deployment-detail"),
    { timeoutMs: waitMs },
  );
  r.ok(
    `clicking "${label}" opens the deployment pane`,
    settled.ok,
    settled.ok ? undefined : `panes present: ${settled.value.join(", ")}`,
  );
  if (!settled.ok) return;

  const panes = settled.value;
  const path = new URL(page.url()).pathname;

  // The route, not just what rendered: `history.state` is the serialized
  // `PaneSlot[]`, so a failure below can be read as "which slots, with which
  // params" rather than guessed at from the DOM.
  const route = JSON.stringify(
    await page.evaluate(
      () => (window.history.state as { route?: unknown } | null)?.route,
    ),
  );

  r.ok(
    "the paramful ancestor is materialized",
    panes.includes("deploy-server-detail"),
    `route is ${route} — the caller's \`serverId\` was dropped, so the deployment pane ` +
      "sits in a route without the server it belongs to",
  );
  r.ok(
    "the URL carries the ancestor's segment",
    /\/server\/[^/]+\/dep\/[^/]+/.test(path),
    `path is ${path} — a deep link to this URL cannot rebuild the server ancestor`,
  );
  r.ok(
    "the PARAMLESS ancestor is not materialized",
    !panes.includes("deploy-servers"),
    `panes present: ${panes.join(", ")} — an ancestor that carries no param was inserted ` +
      "anyway, which adds a column nobody asked for",
  );

  for (const e of pageErrors) r.fail("page error", e);
});

await r.finish();
