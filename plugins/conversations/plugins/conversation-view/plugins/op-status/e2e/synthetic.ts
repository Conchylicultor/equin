import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { spawnPassthrough } from "@plugins/infra/plugins/spawn/core";
import { waitFor } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";

// The op-status e2es' shared half: driving `../scripts/synthetic-op.ts` (a real
// process writing the real op log) and reading the banner it shows up in.

const HELPER = join(import.meta.dir, "..", "scripts", "synthetic-op.ts");

export const BANNER = '[data-ui-owner^="OpStatusBanner@"]';
// Log append → watcher → ingest → change feed → push → render.
export const LIVE_TIMEOUT_MS = 30_000;

export interface Synthetic {
  opId: string;
  /** Resolves when the helper exits. */
  exited: Promise<unknown>;
  /** Ask the helper to advance to step `n` (it watches its control file). */
  advance: (n: number) => void;
  kill: () => void;
  /** Wait until the helper has performed step `n`. */
  step: (n: number) => Promise<boolean>;
}

/**
 * Spawn the helper in `mode` (`run` — the scripted waits; `run-asleep` — an op
 * that slept) for namespace `slug`, under `root/<tag>`. `extra` is appended to
 * its argv (e.g. `["--asleep-ms", "7200000"]`).
 */
export function startSynthetic(
  root: string,
  slug: string,
  tag: string,
  mode: "run" | "run-asleep" = "run",
  extra: string[] = [],
): Synthetic {
  const opId = `e2e-synthetic-${tag}-${crypto.randomUUID()}`;
  const dir = join(root, tag);
  mkdirSync(dir, { recursive: true });
  const ready = join(dir, "ready.json");
  let kill: ((s: NodeJS.Signals) => void) | undefined;
  const exited = spawnPassthrough(
    [
      process.execPath,
      HELPER,
      mode,
      "--slug",
      slug,
      "--op-id",
      opId,
      "--dir",
      dir,
      ...extra,
    ],
    {
      onSpawn: (c) => {
        kill = (s) => c.kill(s);
      },
    },
  );
  const readStep = async (): Promise<number> =>
    existsSync(ready)
      ? (JSON.parse(readFileSync(ready, "utf8")) as { step: number }).step
      : -1;
  return {
    opId,
    exited,
    advance: (n) => {
      // Whole-file via rename, so the helper never reads a torn write.
      const tmp = join(dir, "control.json.tmp");
      writeFileSync(tmp, JSON.stringify({ step: n }));
      renameSync(tmp, join(dir, "control.json"));
    },
    kill: () => kill?.("SIGKILL"),
    step: async (n) =>
      (await waitFor(readStep, (s) => s >= n, { timeoutMs: 20_000 })).ok,
  };
}

/** Close an op the log still has in flight, through the helper's reconciler stand-in. */
export async function closeSynthetic(opId: string): Promise<void> {
  const res = await spawnPassthrough([
    process.execPath,
    HELPER,
    "close",
    "--op-id",
    opId,
  ]);
  if (res.exitCode !== 0)
    throw new Error(`synthetic-op close ${opId} exited ${res.exitCode}`);
}

export async function bannerText(page: Page): Promise<string> {
  const n = await page.locator(BANNER).count();
  return n === 0 ? "" : await page.locator(BANNER).first().innerText();
}

export async function waitBanner(
  page: Page,
  ok: (text: string) => boolean,
  timeoutMs = LIVE_TIMEOUT_MS,
) {
  return waitFor(() => bannerText(page), ok, { timeoutMs });
}
