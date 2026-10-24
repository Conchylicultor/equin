// Contact sheet of every icon the app ships: each manifest symbol drawn from
// the deployed app's own resident sprites, at rest (outline) and active
// (filled) in the default style, plus every brand. Review it after changing
// icon names or upgrading an @iconify-json set.
//
// Usage:
//   ./equin run plugins/ui/plugins/icons/e2e/contact-sheet.ts [--out /tmp/icons] [--color-scheme dark|light]
//
// Reads the names from the sprite sheet in the page (the resident sprites carry
// exactly the manifest), then replaces the page body with a grid that `<use>`s
// those same sprite symbols, so what it shows is what `<Icon>` draws.

import {
  arg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/icons-contact-sheet");
const colorScheme = arg("color-scheme", "light") as "light" | "dark";

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1400, height: 900 },
    colorScheme,
  });
  await page.goto(pathUrl("/"));
  await page.waitForSelector('symbol[id^="ms-default-outline-400-"]', {
    state: "attached",
    timeout: 30_000,
  });

  const counts = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("symbol[id]")].map((s) => s.id);
    const rest = "ms-default-outline-400-";
    const symbols = ids
      .filter((id) => id.startsWith(rest))
      .map((id) => id.slice(rest.length))
      .sort();
    const brands = ids
      .filter((id) => id.startsWith("si-"))
      .map((id) => id.slice(3))
      .sort();
    // Keep the sprite containers: the grid <use>s their symbols.
    const sprites = [...document.querySelectorAll("svg")]
      .filter((svg) => svg.querySelector(":scope > symbol"))
      .map((svg) => svg.outerHTML)
      .join("");
    const glyph = (id: string) =>
      `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><use href="#${id}"/></svg>`;
    const cell = (glyphs: string, label: string) =>
      `<div class="c"><div class="g">${glyphs}</div><div class="n">${label}</div></div>`;
    const cells = [
      ...symbols.map((n) =>
        cell(
          glyph(`ms-default-outline-400-${n}`) +
            glyph(`ms-default-filled-400-${n}`),
          n,
        ),
      ),
      ...brands.map((n) => cell(glyph(`si-${n}`), `brand: ${n}`)),
    ];
    document.body.innerHTML = `<div hidden>${sprites}</div>
      <style>
        body{margin:0;padding:16px;background:var(--background);color:var(--foreground);font:11px system-ui,sans-serif;overflow:visible;height:auto}
        html{height:auto;overflow:visible}
        .grid{display:grid;grid-template-columns:repeat(8,1fr);gap:8px}
        .c{border:1px solid var(--border);border-radius:6px;padding:6px}
        .g{display:flex;gap:6px}.n{margin-top:4px;word-break:break-all;opacity:.7}
      </style>
      <h1 style="font-size:13px">${symbols.length} symbols (outline · active) + ${brands.length} brands — default icon style</h1>
      <div class="grid">${cells.join("")}</div>`;
    return { symbols: symbols.length, brands: brands.length };
  });

  await page.screenshot({ path: `${out}.png`, fullPage: true });
  console.log(
    `${counts.symbols} symbols + ${counts.brands} brands → ${out}.png`,
  );
});
