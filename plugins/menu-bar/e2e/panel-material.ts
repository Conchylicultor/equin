/**
 * The panel page on a transparent helper window: with a stand-in
 * `window.equinNative` whose `hostInfo()` reports the macOS material
 * (`{ cornerRadius: 12 }`), the page must paint NOTHING outside its rounded
 * panel — every corner pixel transparent — and its translucent fill inside.
 * Captured with `omitBackground`, so the page's own paint is all there is,
 * which is what the native window composites over the vibrancy material.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/menu-bar/e2e/panel-material.ts [--out /tmp/panel-material]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { BRIDGE_METHODS } from "@plugins/menu-bar/core";

const OUT = arg("out") ?? "/tmp/panel-material";
const WIDTH = 360;
const HEIGHT = 560;
const RADIUS = 12;

const r = report("Menu-bar panel · transparent window material");

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: WIDTH, height: HEIGHT },
    colorScheme: "dark",
  });
  // The helper's bridge, as bridge.js defines it, answering for a macOS
  // material window; every other method is a no-op.
  await page.addInitScript(
    ({ methods, radius }) => {
      const api: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
      for (const m of methods) api[m] = () => Promise.resolve(undefined);
      api.hostInfo = () =>
        Promise.resolve({
          version: 1,
          platform: "macos",
          capabilities: {
            notify: true,
            attention: true,
            launchApp: true,
            openUrl: true,
          },
          material: { cornerRadius: radius },
        });
      (window as { equinNative?: unknown }).equinNative = api;
    },
    { methods: [...BRIDGE_METHODS], radius: RADIUS },
  );
  await boot(page, pathUrl("/home/menu-bar?embed=1"), {
    marker: "textarea[aria-label='Task']",
  });
  r.eq(
    "html carries data-window-material",
    await page.evaluate(() =>
      document.documentElement.hasAttribute("data-window-material"),
    ),
    true,
  );

  const png = await page.screenshot({
    path: `${OUT}.png`,
    omitBackground: true,
  });
  r.note(`screenshot: ${OUT}.png`);
  // Alpha of the pixels the window's rounded corners cut away (1px in from
  // each corner — inside the window, outside a 12px rounded rect) and of the
  // panel's middle.
  const alphas = await page.evaluate(
    async ({ b64, w }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const sx = img.naturalWidth / w;
      const at = (x: number, y: number) =>
        ctx.getImageData(Math.floor(x * sx), Math.floor(y * sx), 1, 1).data[3]!;
      return {
        topLeft: at(1, 1),
        topRight: at(w - 2, 1),
        middle: at(w / 2, 200),
      };
    },
    { b64: png.toString("base64"), w: WIDTH },
  );
  r.note(`alpha: ${JSON.stringify(alphas)}`);
  r.eq("top-left corner is transparent", alphas.topLeft, 0);
  r.eq("top-right corner is transparent", alphas.topRight, 0);
  r.ok(
    "the panel's middle is a translucent fill",
    alphas.middle > 0 && alphas.middle < 255,
    `alpha ${alphas.middle}`,
  );
  // Which elements still paint an opaque background behind the panel.
  const opaque = await page.evaluate(() => {
    const hits: string[] = [];
    for (const el of [
      document.documentElement,
      ...Array.from(document.querySelectorAll("body, body *")),
    ]) {
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 300) continue;
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(bg);
      const alpha = m ? Number(m[1]!.split(",")[3] ?? "1") : 0;
      if (alpha > 0)
        hits.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)} → ${bg}`,
        );
    }
    return hits;
  });
  for (const line of opaque) r.note(`painted: ${line}`);
});

await r.finish();
