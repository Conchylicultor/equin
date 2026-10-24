// Opens a conversation, reads the agents stat in the transcript's stat strip
// ("3 agents · 165k total"), clicks it and reads the agents card above the
// prompt box it toggles to list every agent; clicks again to toggle back.
// A transcript tool, not a gate: it logs and screenshots, and fails only when
// the stat never appears.
//
// Usage:
//   ./equin run plugins/conversations/plugins/conversation-view/plugins/running-agents/e2e/agents-stat-verify.ts \
//     --conv <conversationId with sub-agents> [--out /tmp/agents-stat] [--headed]

import {
  arg,
  pathUrl,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const CONV = requireArg(
  "conv",
  "--conv <conversationId> is required: a conversation that launched sub-agents.",
);
const OUT = arg("out") ?? "/tmp/agents-stat";

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });
  await page.goto(pathUrl(`/agents/c/${CONV}`));

  const stat = page.locator("button", { hasText: /\d+ agents? · / });
  await stat.first().waitFor({ timeout: 60_000 });
  console.log(`stat: "${(await stat.first().textContent())?.trim()}"`);
  console.log(
    `title: ${(await stat.first().getAttribute("title"))?.replace(/\n/g, " / ")}`,
  );
  await snap(page, OUT, "strip");

  const card = page.getByRole("button", { name: "Running agents" });
  const before = await card.count();
  const dismissFirst = page.getByRole("button", { name: /Dismiss all/ });
  if (await dismissFirst.count()) await dismissFirst.first().click();
  await stat.first().click();
  await page.waitForTimeout(1500);
  console.log(`pressed: ${await stat.first().getAttribute("aria-pressed")}`);
  console.log(
    `card: ${before ? "was up" : "was hidden"} → "${(await card.first().textContent())?.trim()}"`,
  );
  await snap(page, OUT, "all-agents");

  // Slow-operation toasts stack over the strip's right edge on a loaded host.
  const dismiss = page.getByRole("button", { name: /Dismiss all/ });
  if (await dismiss.count()) await dismiss.first().click();
  await stat.first().click();
  await page.waitForTimeout(1000);
  console.log(
    `toggled back: pressed ${await stat.first().getAttribute("aria-pressed")}, card ${(await card.count()) ? "up" : "hidden"}`,
  );
  await snap(page, OUT, "toggled-back");
});
