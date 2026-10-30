// Bundling a page-side entry (under ./page) into one IIFE the host injects:
// the film page's renderer, the recorder's virtual clock.

import { join } from "node:path";

/** `page/<entry>` bundled for the browser as one IIFE script. */
export async function bundlePageScript(entry: string): Promise<string> {
  const out = await Bun.build({
    entrypoints: [join(import.meta.dir, "page", entry)],
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!out.success)
    throw new Error(
      `film: bundling page/${entry} failed:\n${out.logs.map(String).join("\n")}`,
    );
  const js = out.outputs[0];
  if (!js) throw new Error(`film: bundling page/${entry} produced no output`);
  return js.text();
}
