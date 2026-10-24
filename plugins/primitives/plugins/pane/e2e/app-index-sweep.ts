// Scripted end-to-end check that every app's bare root resolves to its index
// pane (see the "The app's index pane (`appIndex`)" section in the pane
// CLAUDE.md).
//
// `appIndex` is the one pane field with NO static enforcement in either
// direction that matters here. Registry sync throws loudly on a segment-bearing
// index pane and on a second index for one app (`useSyncPaneRegistry`), but a
// pane that simply LOSES its `appIndex: true` is silent: the field is optional,
// `pane:segments-unique` skips empty segments, and `type-check` sees nothing.
// The only symptom is that the app's bare root paints an empty main area — so
// the only way to catch it is to open each root and look.
//
// That made it the riskiest single field in the route-form migration, which
// moved every pane's `segment` onto its `RouteDef` while `appIndex` stayed on
// `Pane.define`.
//
// An app is asserted here iff it HAS an index pane. There is deliberately no
// global fallback — `home`, `studio`, `browser`, `file-explorer` and `debug`
// render an empty main area at their bare root, which is a legitimate choice.
//
// Manual, self-contained — NOT wired into any check (tests are manual here):
//
//   ./equin run plugins/primitives/plugins/pane/e2e/app-index-sweep.ts \
//     [--url <deploy>] [--wait <ms>]
//
// Exit 0 = all pass; exit 1 = a failing assertion (with a printed reason).
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
 * Every app that declares an index pane, and the pane id its bare root must
 * resolve to. Kept as literal pairs rather than derived from the `AppRef`s:
 * `e2e` drives the DEPLOYED app and may not import the `web` code under test,
 * and a list derived from the same source as the thing under test would agree
 * with it by construction — including when both are wrong.
 */
const APP_INDEXES: Array<{ basePath: string; paneId: string }> = [
  { basePath: "/agents", paneId: "welcome" },
  { basePath: "/deploy", paneId: "deploy-servers" },
  { basePath: "/events", paneId: "events-root" },
  { basePath: "/mail", paneId: "mail-root" },
  { basePath: "/pages", paneId: "pages-root" },
  { basePath: "/prototypes", paneId: "prototypes-gallery" },
  { basePath: "/settings", paneId: "settings-config-index" },
  { basePath: "/sonata", paneId: "sonata-library" },
  { basePath: "/story", paneId: "story-gallery" },
  { basePath: "/website", paneId: "website-landing" },
  { basePath: "/workflows", paneId: "workflows-definitions" },
];

const r = report();

await withBrowser(async (h) => {
  const { page } = await h.session();

  // A registry-sync throw surfaces as a pageerror, not in the DOM. Collect for
  // the whole run and attribute per app by draining between navigations.
  let pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });

  for (const { basePath, paneId } of APP_INDEXES) {
    pageErrors = [];
    await page.goto(pathUrl(basePath), {
      waitUntil: "domcontentloaded",
      timeout: waitMs,
    });

    // `data-pane-id` is stamped by `PaneBox`, the single sanctioned way to
    // paint a pane — so its presence IS "a pane rendered here". Reading the
    // whole set (rather than waiting on one selector) makes the failure legible:
    // `waitFor` hands back the last value it saw, which is exactly the "what DID
    // render" the diagnostic needs. It also never absorbs a failure — a read
    // that throws is a real error and propagates, where a `.catch(() => false)`
    // would have republished it as "the pane is not there".
    const settled = await waitFor(
      () =>
        page.$$eval("[data-pane-id]", (els) =>
          els.map((e) => e.getAttribute("data-pane-id")),
        ),
      (ids) => ids.includes(paneId),
      { timeoutMs: waitMs },
    );

    r.ok(
      `${basePath} → ${paneId}`,
      settled.ok,
      settled.ok
        ? undefined
        : (settled.value.length
            ? `panes present: ${settled.value.join(", ")}`
            : "no pane rendered at all (empty main area)") +
            ` after ${settled.waitedMs}ms — its \`appIndex: true\` was most` +
            " likely dropped from `Pane.define`",
    );

    for (const e of pageErrors) r.fail(`${basePath}: page error`, e);
  }
});

await r.finish();
