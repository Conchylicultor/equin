// Drives the "Ask an agent" affordance on a conflicted config: opens the
// descriptor's detail pane, clicks the banner button, and checks what the
// launch popover actually rendered — its title, the summary line naming the
// descriptor, the extra-context editor, and the launch control.
//
// Needs a config that is ACTUALLY in conflict in the target namespace (the
// banner is the only place the button lives), so the path is a parameter:
//
//   ./equin run plugins/config_v2/plugins/settings/plugins/conflict-agent/e2e/conflict-agent-verify.ts \
//     --path apps/events/sources/events.sources.jsonc [--headed]
//
// Manual only — nothing runs this automatically.

import {
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const storePath = requireArg(
  "path",
  "--path <store path, e.g. apps/events/sources/events.sources.jsonc>",
);
// The pane param is itself a URL-encoded store path, and the whole param is
// encoded again into the route — hence the double encode.
const url = pathUrl(
  `/settings/config/cd/${encodeURIComponent(encodeURIComponent(storePath))}`,
);
const OUT = "/tmp/conflict-agent";

const r = report(`conflict-agent · ${storePath}`);
r.note(`url: ${url}`);

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });

  await page.goto(url);

  const trigger = page.getByRole("button", {
    name: "Ask an agent",
    exact: true,
  });
  // Wait for the button rather than sampling after a fixed pause: a cold boot
  // after a deploy can take longer than any pause worth hardcoding, and "not
  // booted yet" would read as "no such button". A timeout is this script's
  // answer, not its crash — every other rejection still throws.
  const onBanner = await trigger
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(
      () => true,
      (err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return false;
        throw err;
      },
    );
  await snap(page, OUT, "1-banner");

  r.ok(
    "banner offers Ask an agent",
    onBanner,
    `is ${storePath} actually in conflict in this namespace?`,
  );
  if (!onBanner) await r.finish();

  await trigger.first().click();
  // The popover's editor is code-split, so give it longer than a plain click
  // settle — a spinner where the editor belongs is exactly what this catches.
  await page.waitForTimeout(4000);
  await snap(page, OUT, "2-popover");

  r.ok(
    "popover titled for the conflict",
    (await page
      .getByText("Resolve this config conflict", { exact: true })
      .count()) > 0,
  );
  r.ok(
    "summary names the descriptor",
    (await page.getByText(storePath, { exact: false }).count()) > 0,
  );
  r.ok(
    "extra-context editor rendered",
    (await page.locator('[contenteditable="true"]').count()) > 0,
    "still a spinner? the lazy editor never resolved",
  );
  r.ok(
    "launch control rendered",
    (await page.getByRole("button", { name: /launch/i }).count()) > 0,
  );
});

await r.finish();
