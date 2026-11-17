import { writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { join } from "node:path";

/** The page's sources: its HTML (with the bundle slot) and its entry. */
export const PAGE_SOURCES = "plugins/installer/plugins/window/standalone-page";
const SLOT = "<script>/*BUNDLE*/</script>";

/**
 * The installer page as ONE self-contained HTML file: `main.ts` (and what it
 * imports — the protocol schema in installer/core, zod) bundled for the
 * browser and inlined at the HTML's bundle slot. Nothing in it is fetched.
 */
export async function bundlePage(root: string): Promise<string> {
  const sources = join(root, PAGE_SOURCES);
  const built = await Bun.build({
    entrypoints: [join(sources, "main.ts")],
    target: "browser",
    format: "iife",
    minify: true,
  });
  const [bundle] = built.outputs;
  if (!built.success || bundle === undefined || built.outputs.length !== 1)
    throw new Error(
      `the installer page did not bundle: ${built.logs.map(String).join("\n")}`,
    );
  const js = await bundle.text();
  if (/<\/script/i.test(js))
    throw new Error(
      "the installer page's bundle contains </script, which would end the inline script early",
    );
  const html = await readFile(join(sources, "index.html"), "utf8");
  if (html.split(SLOT).length !== 2)
    throw new Error(
      `${PAGE_SOURCES}/index.html must hold ${SLOT} exactly once`,
    );
  return html.replace(SLOT, () => `<script>${js}</script>`);
}

/** Bundle the page into `dir/page.html`; the env var the crate's build.rs reads. */
export async function writePage(
  root: string,
  dir: string,
): Promise<Readonly<Record<string, string>>> {
  const path = join(dir, "page.html");
  await writeFile(path, await bundlePage(root));
  return envEntries({ INSTALLER_PAGE: path });
}
