import { dirname } from "node:path";

// The entrypoints `release` compiles with `bun build --compile`, shared with
// the `release:fixed-entrypoints-bundle` check so the check measures exactly
// what a release compiles.

/** The backend. Its whole closure is the composition (`@composition-server-registry`). */
export const SERVER_ENTRY =
  "plugins/framework/plugins/server-core/bin/index.ts";

/**
 * The entrypoints whose code is the same for every composition — only the
 * registries they reach depend on it. A release compiles each of them; the
 * check bundles each with those registries empty.
 */
export const FIXED_ENTRIES = {
  launcher: "plugins/infra/plugins/launcher/bin/launch.ts",
  pgStart: "plugins/database/plugins/embedded/scripts/start.ts",
  pgbouncerStart: "plugins/database/plugins/pgbouncer/scripts/start.ts",
  // Tauri-only: the desktop shell runs this on app exit to stop the detached
  // gateway + PG daemons it brought up via `launch`. The web self-extractor has
  // no host process to drive teardown, so it ships no teardown binary.
  teardown: "plugins/infra/plugins/launcher/bin/teardown.ts",
} as const;

/** What one committed registry is bundled as: another file, or inline source. */
export type RegistryTarget =
  { kind: "file"; path: string } | { kind: "contents"; contents: string };

/** Committed registry (absolute path) → what the bundle holds in its place. */
export type RegistryRedirects = ReadonlyMap<string, RegistryTarget>;

const INLINE_NAMESPACE = "redirected-registry";

/**
 * A bundler plugin that replaces every import of a committed registry with its
 * target. Matched on the RESOLVED file, so a registry is replaced however its
 * importer spells the path (relative, alias, with or without `.ts`); any other
 * import falls through to the default resolver.
 */
export function registryRedirectPlugin(
  redirects: RegistryRedirects,
): Bun.BunPlugin {
  return {
    name: "registry-redirects",
    setup(build) {
      build.onResolve({ filter: /\.generated(\.ts)?$/ }, (args) => {
        if (!args.importer) return undefined;
        const resolved = Bun.resolveSync(args.path, dirname(args.importer));
        const target = redirects.get(resolved);
        if (target === undefined) return undefined;
        return target.kind === "file"
          ? { path: target.path }
          : { path: resolved, namespace: INLINE_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: INLINE_NAMESPACE }, (args) => {
        const target = redirects.get(args.path);
        if (target?.kind !== "contents") {
          throw new Error(`No inline registry for ${args.path}.`);
        }
        return { contents: target.contents, loader: "ts" };
      });
    },
  };
}
