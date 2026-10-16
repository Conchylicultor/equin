import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

// Programmatic Vite build of the measurer page (entry.html + entry.tsx) into a
// temp static dir. Reuses the EXACT plugin set + `@plugins` alias from the repo
// `vitest.config.ts`, so the fixtures' real components + real Tailwind are
// bundled identically to the app. `base: "./"` makes asset URLs relative so the
// built page loads over `file://` (no server). Returns the built index.html path.

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "../../../../../../../..");
const PLUGINS_DIR = join(REPO_ROOT, "plugins");

export interface BuiltPage {
  /** Absolute path to the built `index.html`. */
  html: string;
  /** Temp output directory (caller cleans up). */
  outDir: string;
}

export async function buildMeasurerPage(): Promise<BuiltPage> {
  const outDir = await mkdtemp(join(tmpdir(), "layout-harness-"));
  // A PRODUCTION page, whoever builds it — the gate's contract, not a preference.
  //
  // A primitive that throws on a broken construct in dev and degrades quietly in
  // prod must reach this page through its QUIET branch. A fixture that
  // reproduces such a construct deliberately (adaptive-bar's
  // `host-stops-giving-room`) would otherwise crash the page, and a crashed
  // fixture is a fatal `fixture page error` instead of the geometry it exists to
  // assert.
  //
  // `mode` is NOT the lever. Vite resolves `isProduction` from the ambient
  // `process.env.NODE_ENV` first and consults `mode` only when it is unset — and
  // the suite that builds this page runs under `bun test`, which sets
  // `NODE_ENV=test`. So the same source produced a production page when built by
  // hand and a DEVELOPMENT one when built by the gate, with `import.meta.env.DEV`
  // true and every dev-only assertion live.
  //
  // A `define` is not the lever either, and it fails loudly rather than subtly:
  // replacing `import.meta.env.DEV` / `process.env.NODE_ENV` at compile time
  // leaves the react plugin still compiling JSX for the dev runtime, so the page
  // dies on `jsxDEV is not a function`. The flag has to be set BEFORE the config
  // is resolved, which is one env var, restored in `finally` so a build cannot
  // leak it into the suite that called it.
  const priorNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await buildPage(outDir);
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  }
  return { html: join(outDir, "entry.html"), outDir };
}

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
        "@composition-config-layer": join(
          PLUGINS_DIR,
          "../.generated/composition-modules/config-layer.singularity.ts",
        ),
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: join(HERE, "entry.html") },
    },
    logLevel: "error",
  });
}
