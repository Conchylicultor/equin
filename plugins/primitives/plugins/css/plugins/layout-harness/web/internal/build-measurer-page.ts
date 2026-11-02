import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// Builds the measurer page (entry.html + entry.tsx) into a temp static dir, by
// running `build-page.ts` as a child process — see its header for why the
// build never runs inside the calling (test) process. Returns the built
// index.html path.

const BUILD_SCRIPT = join(
  resolve(fileURLToPath(import.meta.url), ".."),
  "build-page.ts",
);

/** A cold Vite + Tailwind build of every exhibit; a bound, not an estimate. */
const BUILD_TIMEOUT_MS = 110_000;

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
  // `NODE_ENV=test`. A `define` is not the lever either: replacing
  // `import.meta.env.DEV` / `process.env.NODE_ENV` at compile time leaves the
  // react plugin compiling JSX for the dev runtime, so the page dies on
  // `jsxDEV is not a function`. The flag has to be set before the config is
  // resolved — the child's own environment, which no caller can leak into.
  const result = await spawnCaptured(
    [process.execPath, "run", BUILD_SCRIPT, outDir],
    {
      env: { ...process.env, NODE_ENV: "production" },
      timeoutMs: BUILD_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `measurer page build exited ${String(result.exitCode)}${result.timedOut ? " (timed out)" : ""}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  return { html: join(outDir, "entry.html"), outDir };
}
