// Probes Sonata's Current key section opening and folding on the recorder's
// virtual clock, the way the film does it (a click on its own header): every
// frame for a second after each click, the fold box's height and opacity and
// every animation on it (play state, currentTime, startTime) — and the
// frames themselves, to see whether the unfold and the fold animate.
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/key-fold-probe.ts \
//     --composition promo-film [--out <dir>]
//
// Needs the song open in Sonata (the `pages` take imported it). Shows the
// section with the film's own config write (reverted when the run ends).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  arg,
  pageFetch,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { resetConfigField } from "@plugins/config_v2/plugins/settings/core";
import {
  SONATA_KEY_SECTION,
  SONATA_SECTION_LAYOUT,
} from "@plugins/apps/plugins/website/plugins/promo-film/plugins/seed/core";
import { installRecorderClock, record } from "@plugins/media/plugins/film/e2e";
import { DPR, H, open, visible, W } from "./internal/session-kit";

const out = arg("out") ?? "/tmp/key-fold-probe";
mkdirSync(out, { recursive: true });

interface FrameProbe {
  t: number;
  height: number | null;
  opacity: number | null;
  anims: {
    playState: string;
    currentTime: number | null;
    startTime: number | null;
    timeline: number | null;
  }[];
}

await withBrowser(
  async (h) => {
    const { page, context } = await h.session({
      viewport: { width: W, height: H },
      deviceScaleFactor: DPR,
      colorScheme: "dark",
      capture: false,
    });
    await installRecorderClock(context);
    await open(page, "/files/browse/~%2FMusic%2FPiano");
    const row = (name: string) =>
      page.locator("[data-tree-row]").filter({ hasText: name }).first();
    await visible(row("music"));
    if (!(await row("wedding-day-at-troldhaugen.mid").isVisible())) {
      await row("music").hover();
      await row("music").getByRole("button", { name: "Expand" }).click();
    }
    await row("wedding-day-at-troldhaugen.mid").click();
    await page.getByRole("button", { name: "Open in Sonata" }).first().click();
    await page.waitForTimeout(4000);
    const [method = "", path = ""] = resetConfigField.route.split(" ");
    const res = await pageFetch(page, path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storePath: SONATA_SECTION_LAYOUT, key: "items" }),
    });
    if (!res.ok) throw new Error(`config write: ${res.status}`);
    const header = page.getByText("Current key", { exact: true }).first();
    await visible(header);
    await page.waitForTimeout(1500);
    const trigger = page.locator(
      `[data-contribution-id="${SONATA_KEY_SECTION}"] button[aria-expanded]`,
    );
    // Start closed.
    if ((await trigger.first().getAttribute("aria-expanded")) === "true") {
      await trigger.first().click();
      await page.waitForTimeout(1000);
    }
    const probe = (): Promise<FrameProbe> =>
      page.evaluate((id) => {
        const box = document.querySelector<HTMLElement>(
          `[data-contribution-id="${id}"] [data-slot="collapsible-content"]`,
        );
        const num = (v: unknown): number | null =>
          typeof v === "number" ? Math.round(v * 10) / 10 : null;
        return {
          t: Math.round(performance.now()),
          height: box ? Math.round(box.getBoundingClientRect().height) : null,
          opacity: box ? Number(getComputedStyle(box).opacity) : null,
          anims: box
            ? box.getAnimations().map((a) => ({
                playState: a.playState,
                currentTime: num(a.currentTime),
                startTime: num(a.startTime),
                timeline: num(document.timeline.currentTime),
              }))
            : [],
        };
      }, SONATA_KEY_SECTION);
    const log: Record<string, FrameProbe[]> = { open: [], fold: [] };
    const box = await header.boundingBox();
    if (!box) throw new Error("no header box");
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await record(
      page,
      { dir: out, name: "key-fold", cursor: at },
      async (r) => {
        await r.hold(0.2);
        for (const phase of ["open", "fold"] as const) {
          await r.click(header, { duration: 0.1 });
          for (let i = 0; i < 50; i++) {
            log[phase]!.push(await probe());
            await r.hold(1 / 60);
          }
        }
      },
    );
    writeFileSync(join(out, "probe.json"), JSON.stringify(log, null, 1));
    for (const phase of ["open", "fold"] as const)
      console.log(
        `${phase}: ${log[phase]!.map((p) => `${p.height ?? "-"}${p.anims.length ? `[${p.anims.map((a) => `${a.playState}@${a.currentTime}`).join(",")}]` : ""}`).join(" ")}`,
      );
  },
  { gpu: true, steadyCaret: true },
);
console.log(`frames + probe.json: ${out}`);
