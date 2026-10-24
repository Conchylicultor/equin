import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AssetMirrorPrewarm } from "../../core";
import { mirrorFetchToDisk } from "./fetch-to-disk";

// The composition-filtered prewarm registry is gitignored and present only after
// a `./equin build --hermetic --composition <name>`. Keyed by that name —
// there is no checkout-global one — and built as a variable (not a string
// literal pointing at the maybe-absent file) so tsc never tries to resolve the
// gitignored module, and gated on `existsSync` so a plain build no-ops without a
// caught import error — mirrors `server-core/bin/plugins-active.ts`.
function compositionRegistryPath(composition: string): string {
  return join(
    import.meta.dir,
    `../../core/prewarm.composition.${composition}.generated.ts`,
  );
}

/**
 * Pre-warm every mirror in the composition's closure into `<destRoot>/<id>/`.
 *
 * Reads the composition-filtered prewarm registry
 * (`../../core/prewarm.composition.<composition>.generated`), which exists ONLY
 * after that composition's build. We dynamic-import it and no-op if absent (a
 * plain build, or a composition with no prewarm contributors) — never a static
 * import, so the served app never pulls this build-time-only file into its
 * closure.
 *
 * For each entry we run its `loader()` to get the {@link AssetMirrorPrewarm}
 * descriptor and download every `file` via {@link mirrorFetchToDisk}.
 *
 * FAIL LOUD: a malformed descriptor or any failed download is collected and
 * thrown as a combined error at the end, aborting the release (mirrors
 * `run-provisions.ts`).
 */
export async function runAssetMirrorPrewarm(opts: {
  /** The composition whose filtered prewarm registry to read. */
  composition: string;
  destRoot: string;
  log?: (m: string) => void;
}): Promise<void> {
  const { destRoot } = opts;
  const log = opts.log ?? (() => {});
  const registry = compositionRegistryPath(opts.composition);

  if (!existsSync(registry)) {
    // No composition-filtered registry → nothing to pre-warm. Plain builds and
    // closures without any prewarm contributor land here.
    log(
      `[asset-mirror] no prewarm registry for composition "${opts.composition}" — skipping`,
    );
    return;
  }

  const { prewarmEntries: entries } = (await import(
    registry
  )) as typeof import("../../core/prewarm.generated");

  if (entries.length === 0) {
    log("[asset-mirror] prewarm registry is empty — nothing to seed");
    return;
  }

  const failures: string[] = [];

  for (const entry of entries) {
    let spec: AssetMirrorPrewarm;
    try {
      const mod = (await entry.loader()) as { default?: unknown };
      const descriptor = mod.default;
      if (
        descriptor === null ||
        typeof descriptor !== "object" ||
        typeof (descriptor as AssetMirrorPrewarm).id !== "string" ||
        typeof (descriptor as AssetMirrorPrewarm).remoteBaseUrl !== "string" ||
        !Array.isArray((descriptor as AssetMirrorPrewarm).files)
      ) {
        failures.push(
          `${entry.pluginPath}/prewarm — default export is not a valid AssetMirrorPrewarm descriptor`,
        );
        continue;
      }
      spec = descriptor as AssetMirrorPrewarm;
    } catch (err) {
      failures.push(
        `${entry.pluginPath}/prewarm — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      continue;
    }

    log(
      `[asset-mirror] pre-warming "${spec.id}" (${spec.files.length} file(s)) from ${spec.remoteBaseUrl}`,
    );
    for (const file of spec.files) {
      try {
        await mirrorFetchToDisk({
          remoteBaseUrl: spec.remoteBaseUrl,
          file,
          diskPath: join(destRoot, spec.id, file),
        });
      } catch (err) {
        failures.push(
          `${spec.id}/${file} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[asset-mirror] ${failures.length} prewarm step(s) failed:\n  ${failures.join("\n  ")}`,
    );
  }
}
