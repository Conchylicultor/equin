// Reusable Playwright capture for UI verification — a plain snapshot of a
// screen, or a before/after around an interaction (click a button, inspect the
// state it leaves).
//
// Usage:
//   ./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
//     [--path <route>] [--click <aria-label>] [--out <path>] [--color-scheme dark|light]
//
// --path names the screen: `--path /agents`. The deploy is not named at all in
// the ordinary case — with no target flag this opens the one THIS CHECKOUT
// published, at the root, so the bare command screenshots the app you just
// built. There is no hostname to substitute by hand and no way to land on
// somebody else's app by guessing one: a checkout that has published nothing
// gets a refusal naming the fix, never a plausible-looking URL.
//
// To reach a deploy that is not this checkout's own app:
//   --composition sonata                  a composition this checkout published
//   --url http://<ns>.localhost:9000/…    any deploy, path included (its origin
//                                         says which deploy, its path which
//                                         screen; --base / --origin are aliases)
//
// The capture waits for the page to be RENDERED, not for a fixed time: it
// re-captures until the screen is more than one flat colour (an app still
// booting is its bare background — the "black screenshot"), then for network
// idle, then `--wait` more for post-paint settling. A page that never paints
// within the deadline fails the run (exit 1) instead of handing back a black
// PNG that reads as evidence; so does any capture `snap()` finds blank.
//
// By default the screenshot inherits the host OS appearance (macOS dark/light)
// so a `colorMode: "system"` app renders exactly as the user sees it. Pass
// `--color-scheme dark|light` to force one. Other flags: --wait <ms> (extra
// settle after the page has painted, default 1000), --viewport <WxH>, --headed.
//
// Example:
//   ./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
//     --path /agents/c/<id> \
//     --click "Design docs" \
//     --out /tmp/docs
//
// Produces `<out>-before.png` and (if --click) `<out>-after.png`, and logs
// the matched button's state (disabled, aria-pressed, text). Copy and adapt
// for richer flows (multi-click, assertions, etc.).

import type { Locator } from "playwright";
import { arg, numArg } from "./args";
import { pageUrl } from "./target";
import { withBrowser } from "./browser";
import { detectOsColorScheme, type ColorScheme } from "./color-scheme";
import { snap } from "./shots";
import { flatness, hexColor } from "./pixels";
import { waitFor, ELEMENT_TIMEOUT_MS } from "./wait";
import { waitForNetworkIdle } from "./network-idle";

const url = pageUrl();
const click = arg("click");
const out = arg("out", "/tmp/screenshot");
const waitMs = numArg("wait", 1000);
const viewportRaw = arg("viewport", "1400x900").split("x").map(Number);
const viewport = {
  width: viewportRaw[0] ?? 1400,
  height: viewportRaw[1] ?? 900,
};
const colorScheme = (arg("color-scheme") ??
  detectOsColorScheme()) as ColorScheme;

console.log(`url:          ${url}`);
console.log(`color-scheme: ${colorScheme}`);

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport, colorScheme });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  // On a loaded machine (builds holding the CPU) the app can take well over
  // any fixed sleep to first paint — 4 s and 8 s both captured a black frame.
  const painted = await waitFor(
    async () => flatness(page, await page.screenshot()),
    (v) => !v.flat,
    { timeoutMs: ELEMENT_TIMEOUT_MS, intervalMs: 500 },
  );
  if (painted.value.flat) {
    console.error(
      `page never painted: still one flat colour (${hexColor(painted.value.color)}) ` +
        `after ${painted.waitedMs}ms — the app did not render`,
    );
    await snap(page, out, "before", { allowBlank: true });
    process.exitCode = 1;
    return;
  }
  console.log(`painted after ${painted.waitedMs}ms`);
  await waitForNetworkIdle(page);
  await page.waitForTimeout(waitMs);
  if (!(await snap(page, out, "before")).ok) process.exitCode = 1;

  if (!click) return;

  // A "clickable" is anything button-shaped: plain buttons, but also
  // SegmentedControl options (role=radio), tabs, and toggle chips — a <button>
  // with an overriding role is invisible to getByRole("button").
  const roles = ["button", "radio", "tab", "menuitem", "switch"] as const;
  // Poll instead of sampling once: on a cold boot the app can take longer than
  // the fixed --wait to first paint, and a single count() check reads as
  // "no such button" when the truth is "not booted yet".
  const deadline = Date.now() + 20_000;
  let btn: Locator | null = null;
  while (!btn && Date.now() < deadline) {
    for (const role of roles) {
      // exact: getByRole's default name match is substring, which happily
      // "matches" any long text that merely contains the label.
      const candidate = page.getByRole(role, { name: click, exact: true });
      if ((await candidate.count()) > 0) {
        btn = candidate;
        break;
      }
    }
    if (!btn) await page.waitForTimeout(500);
  }
  if (!btn) {
    console.error(`no clickable (${roles.join("/")}) matched "${click}"`);
    process.exitCode = 1;
    return;
  }

  const first = btn.first();
  console.log("clickable:", {
    role: await first.evaluate(
      (el) => el.getAttribute("role") ?? el.tagName.toLowerCase(),
    ),
    disabled: await first.isDisabled(),
    pressed: await first.getAttribute("aria-pressed"),
    checked: await first.getAttribute("aria-checked"),
    text: (await first.innerText()).slice(0, 80),
  });
  await first.click();
  await page.waitForTimeout(1500);
  if (!(await snap(page, out, "after")).ok) process.exitCode = 1;
});
