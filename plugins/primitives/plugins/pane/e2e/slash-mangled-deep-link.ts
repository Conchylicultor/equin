// Scripted end-to-end check for slash-mangled route paths — the address bar as
// UNTRUSTED INPUT (see the "address bar is untrusted input" section in the pane
// CLAUDE.md, and `normalizeRoutePath` in pane/core).
//
// A pathname with a repeated slash used to fail twice on one load:
//
//   • The boot replace-stamp committed `window.location.pathname` verbatim, so
//     `replaceState(s, "", "//agents/c/x")` resolved SCHEME-RELATIVE to
//     `http://agents/c/x` and threw SecurityError — a hard boot crash.
//   • `"//agents/c/x".startsWith("/agents/")` is false, so the URL owned no app
//     and the deep link silently fell back to the default app.
//
// Every routing read now goes through `currentRoutePath()`, so all three mangled
// forms must land on the SAME canonical URL as the clean control, with no
// SecurityError anywhere on the page.
//
// Manual, self-contained — NOT wired into any check (tests are manual here):
//
//   ./equin run plugins/primitives/plugins/pane/e2e/slash-mangled-deep-link.ts \
//     --conv-id conv-1785314012-zlzw [--url <deploy>] [--wait <ms>]
//
// Exit 0 = all pass; exit 1 = a failing assertion (with a printed reason).
import {
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const convId = requireArg(
  "conv-id",
  "Usage: bun plugins/primitives/plugins/pane/e2e/slash-mangled-deep-link.ts --conv-id <convId> [--url <deploy>] [--wait <ms>]",
);
const waitMs = numArg("wait", 20000);

/** The canonical form every variant below must converge on. */
const canonical = `/agents/c/${convId}`;

const variants: Array<{ label: string; path: string }> = [
  { label: "control (already canonical)", path: canonical },
  { label: "doubled leading slash", path: `/${canonical}` },
  { label: "tripled leading slash", path: `//${canonical}` },
  { label: "doubled slash mid-path", path: `/agents//c/${convId}` },
];

const r = report();

await withBrowser(async (h) => {
  const { page } = await h.session();

  // A SecurityError from replaceState surfaces as a pageerror, not in the DOM —
  // collect for the whole run and attribute per variant by index.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });

  for (const v of variants) {
    const before = pageErrors.length;
    await page.goto(pathUrl(v.path), { waitUntil: "commit" });

    // Poll for the URL to settle on the canonical form (the boot replace-stamp
    // rewrites the address bar in place), bounded by the ceiling.
    const deadline = Date.now() + waitMs;
    for (;;) {
      const done = await page.evaluate(
        (want) => location.pathname === want,
        canonical,
      );
      if (done || Date.now() > deadline) break;
      await page.waitForTimeout(250);
    }

    const landed = await page.evaluate(() => location.pathname);
    const mine = pageErrors.slice(before);
    const security = mine.filter((e) =>
      /SecurityError|history state object/i.test(e),
    );

    console.log(`${v.label}: ${v.path} → ${landed}`);
    r.ok(
      `${v.label}: canonicalizes to ${canonical}`,
      landed === canonical,
      `pathname=${landed}`,
    );
    r.ok(
      `${v.label}: no SecurityError from a scheme-relative history URL`,
      security.length === 0,
      security.join(" | "),
    );
  }

  await r.finish();
});
