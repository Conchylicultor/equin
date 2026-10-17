// Screenshots one exhibit — every width frame, inside the theme it is viewed
// in — by opening its viewer pane directly (`/debug/exhibits/x/<id>;theme=…`),
// so a component can be looked at populated without data in the worktree DB
// and without scrolling a gallery.
//
// Usage:
//   ./singularity run plugins/plugin-meta/plugins/exhibits/e2e/exhibit-shot.ts \
//     --id <group/name> [--id <group/name> …] [--theme <app-id>|chrome] \
//     [--out /tmp/exhibit] [--color-scheme light|dark]
//
// Find ids with `rg -n 'id: "' -g '**/exhibits/**' plugins`, or in Debug →
// Exhibits. `--theme` is an app id (`agent-manager`, `pages`, …) or `chrome`;
// absent, the frames wear the exhibit's declared `home` (else Debug's, the
// viewer pane's own app).
//
// Writes `<out>-<group>_<name>[-<theme>]-<scheme>.png` per id.

import {
  arg,
  pathUrl,
  usage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const ids = process.argv.flatMap((a, i, all) =>
  a === "--id" && all[i + 1] !== undefined ? [all[i + 1] as string] : [],
);
if (ids.length === 0) {
  usage(
    "exhibit-shot.ts --id <group/name> [--id …] [--theme <app-id>|chrome] [--out <prefix>] [--color-scheme light|dark]",
  );
}
const out = arg("out", "/tmp/exhibit");
const theme = arg("theme");
const colorScheme = arg("color-scheme", "light") === "dark" ? "dark" : "light";

/** The viewer pane's path: the id spelled as path segments, like the route's `:id*`. */
function exhibitPath(id: string): string {
  const segments = id.split("/").map(encodeURIComponent).join("/");
  const keyed =
    theme === undefined ? "" : `;theme=${encodeURIComponent(theme)}`;
  return `/debug/exhibits/x/${segments}${keyed}`;
}

await withBrowser(async (h) => {
  // Wide and tall enough that the list pane plus the widest frame fit.
  const { page } = await h.session({
    viewport: { width: 1800, height: 1400 },
    colorScheme,
  });
  for (const id of ids) {
    await page.goto(pathUrl(exhibitPath(id)));
    const frames = page.locator("[data-exhibit-frames]");
    const missing = page.getByText(`No exhibit is called “${id}”`);
    await frames
      .or(missing)
      .first()
      .waitFor({ state: "visible", timeout: 45_000 });
    if (await missing.isVisible()) {
      throw new Error(`no exhibit "${id}" in this build`);
    }
    // App exhibits load their component lazily; let the frames settle.
    await page.waitForTimeout(4000);
    const suffix = theme === undefined ? "" : `-${theme}`;
    const path = `${out}-${id.replace(/\//g, "_")}${suffix}-${colorScheme}.png`;
    await frames.screenshot({ path });
    console.log(`wrote ${path}`);
  }
});
