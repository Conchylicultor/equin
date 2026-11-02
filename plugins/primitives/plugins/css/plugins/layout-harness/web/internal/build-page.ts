import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

// The measurer page's Vite build, run as its OWN process by
// `build-measurer-page.ts` (`bun run build-page.ts <outDir>`, with
// `NODE_ENV=production` in its environment). Never imported by the suite: a
// build tool loaded into the shared `bun test` process inherits whatever the
// 1800 suites before it left on the realm — in the full run Vite died at load
// inside `Error.captureStackTrace` ("First argument must be an Error object"),
// an "unhandled error between tests" that never reproduced alone.
//
// Reuses the EXACT plugin set + `@plugins` alias from the repo
// `vitest.config.ts`, so the fixtures' real components + real Tailwind are
// bundled identically to the app. `base: "./"` makes asset URLs relative so the
// built page loads over `file://` (no server).

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "../../../../../../../..");
const PLUGINS_DIR = join(REPO_ROOT, "plugins");

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: build-page.ts <outDir>");
if (process.env.NODE_ENV !== "production")
  throw new Error(
    `build-page.ts must run with NODE_ENV=production (got ${String(process.env.NODE_ENV)}) — see build-measurer-page.ts`,
  );
await buildPage(outDir);

async function buildPage(outDir: string): Promise<void> {
  await build({
    root: HERE,
    base: "./",
    // The composition alias mirrors vitest.config — entry.tsx pulls
    // loadExhibits(), whose generated registry dynamic-imports EVERY plugin's
    // `exhibits/index.ts` (app exhibits included, each a chunk behind its own
    // `load()` that the page never calls), and those transitively may hit
    // App-level registries through the @plugins tree.
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@plugins": PLUGINS_DIR,
        "@composition-web-registry": join(
          PLUGINS_DIR,
          "framework/plugins/web-sdk/core/web.generated.ts",
        ),
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      rolldownOptions: {
        input: join(HERE, "entry.html"),
        // A demo scenario names its browser host (`@browser-host/<plugin>`), a
        // module only a composed dist maps; the page never starts one.
        external: (id) => id.startsWith("@browser-host/"),
      },
    },
    logLevel: "error",
  });
}
