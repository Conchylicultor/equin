// Baking in the workers draws exactly what baking on the page draws, on THIS
// checkout's deploy: the growth exhibit (`isle/growth`) at --apps N bakes the
// same view twice — workers, then page — and compares the engine's
// fingerprints (`IsleEngine.bakedDigest`: every ground tile's colour and water
// mask, island preview, finished map tile's ground and object layers, and
// building hit mask) on every key both runs hold. The pointer sweeps the view
// first, so both runs read the hit masks of the buildings it crosses.
//
// Usage:
//   ./equin run plugins/apps/plugins/isle/plugins/dev/e2e/bake-identity.ts \
//     [--apps 14] [--out "$EQUIN_SCRATCH/isle-identity"]
//
// Exits non-zero on any differing key, or when the runs share too few keys to
// say anything.

import {
  arg,
  numArg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const apps = numArg("apps", 14);
const out = arg("out", "/tmp/isle-identity");

async function bakeOnce(page: Page, mode: "workers" | "page") {
  const toggle = page.getByRole("button", { name: /^Bake: / });
  if ((await toggle.textContent())?.trim() !== `Bake: ${mode}`)
    await toggle.click();
  const t0 = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "Rebuild" }).click();
  await page.waitForFunction(
    (since) =>
      Number(
        document
          .querySelector("[data-isle-ready]")
          ?.getAttribute("data-isle-ready") ?? 0,
      ) > since,
    t0,
    { timeout: 180_000, polling: 100 },
  );
  // the pointer across the view: hit tests read the masks of what it crosses
  const box = (await page.locator(".isle-growth-frame").boundingBox())!;
  for (let y = 0.15; y < 0.95; y += 0.1)
    for (let x = 0.05; x < 0.95; x += 0.05)
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
  await page.waitForTimeout(6000); // idle: queued masks read, bakes settled
  await page.getByRole("button", { name: "Digest" }).click();
  const text = await page.locator("[data-isle-digest]").textContent();
  await snap(page, out, mode);
  return JSON.parse(text ?? "{}") as Record<string, string>;
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1400, height: 1000 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/debug/exhibit-stage/isle/growth"));
  const count = page.getByLabel("Apps", { exact: true });
  await count.waitFor({ timeout: 120_000 });
  await count.fill(String(apps));
  await count.press("Enter");
  const workers = await bakeOnce(page, "workers");
  const onPage = await bakeOnce(page, "page");
  const shared = Object.keys(workers).filter((k) => k in onPage);
  const differ = shared.filter((k) => workers[k] !== onPage[k]);
  const kinds = new Map<string, number>();
  for (const k of shared) {
    const kind = k.slice(0, k.indexOf(":"));
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log(
    `${apps} apps: ${shared.length} keys in both runs (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")}); ` +
      `workers-only ${Object.keys(workers).length - shared.length}, page-only ${Object.keys(onPage).length - shared.length}`,
  );
  for (const k of differ.slice(0, 20))
    console.log(`  DIFFERS ${k}: workers ${workers[k]} page ${onPage[k]}`);
  if (differ.length)
    throw new Error(`${differ.length} of ${shared.length} bakes differ`);
  if ((kinds.get("ground") ?? 0) < 4 || (kinds.get("mask") ?? 0) < 1)
    throw new Error("the runs share too few bakes to compare");
  console.log("identical ✓");
});
