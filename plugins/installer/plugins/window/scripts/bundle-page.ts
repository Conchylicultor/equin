/**
 * Bundles the installer page into one HTML file, for a cargo build outside
 * infra/deps — the release workflow (`.github/workflows/installer-release.yml`)
 * builds the page once and hands it to every platform's `cargo build` as
 * `EQUIN_INSTALLER_PAGE`. Locally the `installer-window` dependency does
 * this itself; `./equin run` this only to look at the file.
 *
 *   bun plugins/installer/plugins/window/scripts/bundle-page.ts <out.html>
 */
import { writeFile } from "node:fs/promises";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { bundlePage } from "../deps/internal/page";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: bundle-page.ts <out.html>");
await writeFile(out, await bundlePage(REPO_ROOT));
console.log(`installer page → ${out}`);
