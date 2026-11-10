import type { AssetMirrorSource } from "./source";

/**
 * Prewarm contribution: the files the release pipeline bakes into the bundle
 * for offline cold start — a pinned subset of one mirror's source.
 *
 * A plugin drops a `prewarm/index.ts` default-exporting
 * `defineAssetMirrorPrewarm({ source, files? })`. Codegen discovers it (via the
 * `defineCollectedDir("prewarm")` marker in this plugin's core) into
 * `./prewarm.generated.ts`; a composition build emits the closure-filtered
 * `./prewarm.composition.<name>.generated.ts` the release runner reads.
 *
 * The descriptor is self-contained data (no live mirror registry) so the
 * release runner reads it without booting the server; it is an
 * {@link AssetMirrorSource} itself, so each file carries its pin.
 */
export type AssetMirrorPrewarm = AssetMirrorSource;

/**
 * Declare the files of `source` to pre-warm into release bundles — every file
 * it pins when `files` is omitted. Default-export the result from a plugin's
 * `prewarm/index.ts`. A name the source does not pin throws at module eval.
 */
export function defineAssetMirrorPrewarm<F extends string>(spec: {
  source: AssetMirrorSource<F>;
  files?: readonly NoInfer<F>[];
}): AssetMirrorPrewarm {
  const { source } = spec;
  if (spec.files === undefined) return source;
  const pinned = source.files as Record<string, string>;
  const files: Record<string, string> = {};
  for (const name of spec.files) {
    if (!Object.hasOwn(pinned, name)) {
      throw new Error(
        `[asset-mirror:${source.id}] prewarm names "${name}", which the mirror does not pin`,
      );
    }
    files[name] = pinned[name]!;
  }
  return { ...source, files };
}
