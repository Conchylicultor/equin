// Verifies the arc's click-to-pin tooltip on a conversation header: a click
// opens it, it stays open after the pointer leaves, Esc closes it, and a
// second click toggles it shut.
//   ./equin run plugins/ui/plugins/segmented-progress-bar/plugins/arc/e2e/pin-verify.ts --path /agents/c/<id>
import { pageUrl } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { withBrowser } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const url = pageUrl();
await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  page.on("console", (m) => {
    if (m.text().startsWith("TIPDBG")) console.log(m.text());
  });
  await page.goto(url);
  const btn = page.getByRole("button", { name: / · step \d of \d$/ }).first();
  await btn.waitFor({ timeout: 20_000 });
  const tip = page.getByText("How far this agent has got with its task");
  const visible = async () =>
    (await tip.count()) > 0 && (await tip.first().isVisible());
  const results: Record<string, boolean> = {};
  await btn.hover();
  await page.waitForTimeout(800);
  results["open on first hover"] = await visible();
  await page.mouse.move(700, 500);
  await page.waitForTimeout(800);
  results["closed on hover out"] = !(await visible());
  await btn.click();
  await page.mouse.move(700, 500);
  await page.waitForTimeout(800);
  results["open after click + pointer away"] = await visible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  results["closed after Esc"] = !(await visible());
  await btn.click();
  await page.waitForTimeout(300);
  await btn.click();
  await page.mouse.move(700, 500);
  await page.waitForTimeout(800);
  results["closed after second click"] = !(await visible());
  await btn.click();
  await page.mouse.click(700, 500);
  await page.waitForTimeout(500);
  results["closed after outside click"] = !(await visible());
  await page.mouse.move(690, 510);
  await page.waitForTimeout(300);
  await btn.hover();
  await page.waitForTimeout(1500);
  results["open on hover after dismiss"] = await visible();
  console.log(results);
  if (Object.values(results).some((v) => !v))
    throw new Error("pin behaviour failed");
});
