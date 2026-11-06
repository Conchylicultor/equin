// Verifies the render-loop detector's two discriminations on a live page,
// reading the reports it POSTs (each is a real report in this worktree's DB):
//
//   1. an imperative no-op attribute loop (a rAF rewriting one attribute to its
//      own value, no React involved) is filed — with attribution saying no
//      component re-renders at a loop's rate;
//   2. the same loop inside an `ANIMATION_HOST` element is NOT filed;
//   3. (optional, --vision) the Vision zoom left playing on its last chapter
//      files nothing.
//
// Usage:
//   ./equin run plugins/reports/plugins/render-loop/e2e/render-loop-verify.ts [--vision]
//
// Manual only — nothing runs this automatically.

import type { Page } from "playwright";
import {
  boot,
  flag,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { ANIMATION_HOST_ATTR, RENDER_LOOP } from "../core";

interface Filed {
  message: string;
  data: {
    signature: string;
    reactCommitsPerSec?: number | null;
    initiators?: unknown[] | null;
  };
}

/** Every render-loop report the page POSTs, as it goes out. */
function collect(page: Page): Filed[] {
  const filed: Filed[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().includes("/api/reports")) return;
    const body = req.postDataJSON() as { kind?: string } & Filed;
    if (body.kind === "render-loop") filed.push(body);
  });
  return filed;
}

/** Long enough for a loop to sustain, be attributed and be posted. */
const SETTLE_MS = RENDER_LOOP.SUSTAINED_MS + RENDER_LOOP.ATTRIBUTE_MS + 2500;

/** Start a rAF loop rewriting `data-tick="1"` on a new box, optionally inside a host. */
const startLoop = (page: Page, id: string, inHost: boolean) =>
  page.evaluate(
    ({ id, inHost, hostAttr }) => {
      const parent = document.createElement("div");
      if (inHost) parent.setAttribute(hostAttr, "");
      const box = document.createElement("div");
      box.id = id;
      parent.append(box);
      document.body.append(parent);
      // Several writes a frame: a loaded headless host can draw at 5 fps, and
      // the loop must still clear the no-op threshold (30/s).
      const tick = () => {
        for (let i = 0; i < 10; i++) box.setAttribute("data-tick", "1");
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { id, inHost, hostAttr: ANIMATION_HOST_ATTR },
  );

await withBrowser(async (h) => {
  const r = report("render-loop detector");
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  const filed = collect(page);

  if (flag("vision")) {
    await boot(page, pathUrl("/website/vision"), {
      marker: "text=A vision for",
      settleMs: 1500,
    });
    await page.mouse.move(700, 450);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(SETTLE_MS + 3000);
    const vision = filed.filter((f) =>
      f.data.signature.includes("website-vision"),
    );
    r.ok(
      "the vision zoom playing on its own files no render loop",
      vision.length === 0,
      vision.map((f) => f.message).join("\n"),
    );
  } else {
    await boot(page, pathUrl("/home"), { settleMs: 1500 });
  }

  const before = filed.length;
  await startLoop(page, "rl-hosted", true);
  await page.waitForTimeout(SETTLE_MS);
  const hosted = filed.slice(before);
  r.ok(
    "a loop inside an animation host is not filed",
    hosted.length === 0,
    hosted.map((f) => f.message).join("\n"),
  );

  await startLoop(page, "rl-bare", false);
  await page.waitForTimeout(SETTLE_MS);
  const bare = filed.find((f) =>
    f.message.startsWith("Render loop: noop-attr"),
  );
  r.ok(
    "a bare imperative no-op loop is filed",
    bare !== undefined,
    filed.map((f) => f.message).join("\n"),
  );
  r.ok(
    "its attribution says no component re-renders at a loop's rate",
    bare?.data.reactCommitsPerSec != null && bare.data.initiators?.length === 0,
    JSON.stringify({
      message: bare?.message,
      commits: bare?.data.reactCommitsPerSec,
      initiators: bare?.data.initiators,
    }),
  );

  await r.finish();
});
