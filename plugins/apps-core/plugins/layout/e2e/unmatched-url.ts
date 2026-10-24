// Verifies the three outcomes AppsLayout can produce for a URL, against the
// deployed app. The distinction is the whole point of `resolveUnmatchedUrl`:
// only bare `/` may have its address bar rewritten. A broken link keeps its URL
// and says so, because silently redirecting it to the homepage destroys the one
// clue to what went wrong.
//
//   ./equin run plugins/apps-core/plugins/layout/e2e/unmatched-url.ts [--headed]
//
// Writes a screenshot per case to /tmp/unmatched-url-<case>.png.
//
// Every wait is on a real signal, never a fixed sleep: the not-found verdict is
// gated on the deferred plugin tier settling, which on a cold artifact cache
// takes several seconds — a sleep tuned to a warm boot reports "still loading"
// as a failure.

import { errors as pwErrors } from "playwright";
import {
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const LEGACY_TASK_LINK = "/tasks/t/task-1785587694879-3nr2k0";
const DEEP_LINK = "/agents/tasks/t/does-not-exist-xyz";
const SETTLE_MS = 20_000;

/**
 * Await a wait that is *allowed* to time out, because "it never appeared" is an
 * outcome this script asserts on rather than a crash. ONLY a timeout is
 * absorbed — anything else (a closed page, a bad selector, a navigation error)
 * is a real bug and rethrown, so it can't masquerade as a tidy assertion
 * failure pointing at the wrong thing.
 */
async function settled(wait: Promise<unknown>): Promise<boolean> {
  try {
    await wait;
    return true;
  } catch (err) {
    if (err instanceof pwErrors.TimeoutError) return false;
    throw err;
  }
}

const r = report("apps-layout unmatched URL");

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1280, height: 800 } });
  const shot = (name: string) =>
    page.screenshot({ path: `/tmp/unmatched-url-${name}.png` });
  const pathname = () => new URL(page.url()).pathname;

  // ── A legacy link that lost its app prefix: no app owns `/tasks`, so this is
  // the case that used to land on the homepage with no explanation.
  await page.goto(pathUrl(LEGACY_TASK_LINK));
  const noSuchRoute = page.getByText("This page doesn't exist");
  await settled(noSuchRoute.waitFor({ timeout: SETTLE_MS }));
  await shot("legacy-task-link");

  r.eq("legacy link keeps its URL", pathname(), LEGACY_TASK_LINK);
  r.ok("legacy link explains itself", await noSuchRoute.isVisible());
  // `exact` scopes this to the surface's own badge — a substring match would
  // also hit the browser tab strip, where a conversation title can quote the
  // very URL under test (it did, and passed a broken build).
  r.ok(
    "legacy link echoes the offending path",
    await page.getByText(LEGACY_TASK_LINK, { exact: true }).isVisible(),
    "the path is the one actionable detail — it shows the missing /agents prefix",
  );
  r.ok(
    "legacy link offers a way out",
    await page.getByRole("button", { name: /^Go to / }).isVisible(),
  );

  // ── Bare root is the ONE path that may still be rewritten: nothing to destroy.
  await page.goto(pathUrl("/"));
  await settled(
    page.waitForFunction(() => location.pathname !== "/", undefined, {
      timeout: SETTLE_MS,
    }),
  );
  await shot("bare-root");
  r.ok(
    "bare root still canonicalizes to the default app",
    pathname() !== "/" && pathname().length > 1,
    `got ${pathname()}`,
  );

  // ── An app-matched URL whose entity is missing is a DIFFERENT failure, owned
  // by the pane's own resolve guard — it must stay in-place, not become this
  // surface, and must not redirect either.
  await page.goto(pathUrl(DEEP_LINK));
  await settled(
    page.getByText("Not Found").first().waitFor({ timeout: SETTLE_MS }),
  );
  await shot("deep-link-bad-id");
  r.eq("unknown task id keeps its URL", pathname(), DEEP_LINK);
  r.ok(
    "unknown task id gets the pane's Not Found, not the no-app surface",
    !(await page
      .getByText("No installed app handles this address")
      .isVisible()),
  );
});

await r.finish();
