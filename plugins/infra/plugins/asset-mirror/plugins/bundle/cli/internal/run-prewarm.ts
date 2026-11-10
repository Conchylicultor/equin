import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  cachedFileSegments,
  type AssetMirrorPrewarm,
  type CollectedEntry,
} from "@plugins/infra/plugins/asset-mirror/core";
import { mirrorFetchToDisk } from "./fetch-to-disk";

// The composition-filtered prewarm registry is gitignored and present only after
// a `./equin build --hermetic --composition <name>`. Keyed by that name —
// there is no checkout-global one — and built as a variable (not a string
// literal pointing at the maybe-absent file) so tsc never tries to resolve the
// gitignored module, and gated on `existsSync` so a plain build no-ops without a
// caught import error — mirrors `server-core/bin/plugins-active.ts`.
function compositionRegistryPath(composition: string): AppPath {
  return joinAppPath(
    asAppPath(join(REPO_ROOT, "plugins/infra/plugins/asset-mirror/core")),
    `prewarm.composition.${composition}.generated.ts`,
  );
}

/**
 * Pre-warm every mirror in the composition's closure into `<destRoot>/<id>/<sha256>`
 * (the cache's content-addressed layout), each file checked against its pin.
 *
 * Reads the composition-filtered prewarm registry
 * (asset-mirror's `core/prewarm.composition.<composition>.generated`), which exists ONLY
 * after that composition's build. We dynamic-import it and no-op if absent (a
 * plain build, or a composition with no prewarm contributors) — never a static
 * import, so the served app never pulls this build-time-only file into its
 * closure.
 *
 * For each entry we run its `loader()` to get the {@link AssetMirrorPrewarm}
 * descriptor and download every pinned file via {@link mirrorFetchToDisk}.
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

  const { prewarmEntries: entries } = (await import(registry)) as {
    prewarmEntries: CollectedEntry[];
  };

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
        typeof (descriptor as AssetMirrorPrewarm).files !== "object" ||
        (descriptor as AssetMirrorPrewarm).files === null
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

    const files = Object.entries(spec.files);
    log(
      `[asset-mirror] pre-warming "${spec.id}" (${files.length} pinned file(s)) from ${spec.remoteBaseUrl}`,
    );
    for (const [file, sha256] of files) {
      try {
        // The cache's own content-addressed layout, so the launch seed is a
        // plain copy into the cache root.
        await mirrorFetchToDisk({
          source: spec,
          file,
          diskPath: join(destRoot, ...cachedFileSegments(spec, sha256)),
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
