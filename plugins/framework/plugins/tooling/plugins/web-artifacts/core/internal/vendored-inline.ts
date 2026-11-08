// The module-identity guard: no artifact bundles modules of an npm package
// outside the inline allowlist. Vendoring is what guarantees one module
// instance per package; an inlined copy of a stateful package (React context
// registries, scheduler, …) is the silent dual-instance bug class.
//
// It runs where the bytes are made — on each artifact as it builds, before it
// is published — so its cost is the artifacts a build actually built, and an
// offending artifact never enters the store. Reused (unbuilt) artifacts need no
// re-scan: this file and `INLINE_PACKAGES` both feed the builder identity
// (`builderSourceDigest`, `identity.ts`), so changing either rebuilds the whole
// fleet once, through this guard.
//
// (It used to be the `web-artifacts:no-vendored-state-inlined` check, which
// re-derived the verdict on every check pass: an `existsSync` per expected
// artifact plus one per entry of a host-wide verdict cache — ~58k entries,
// 4–7 s of the check thread per build.)

import { INLINE_PACKAGES } from "../constants";

/**
 * The npm packages whose modules a built artifact INLINED, read from its
 * sourcemap `sources`. The sourcemap is the one reliable positive inclusion
 * signal: the meta's `staticImportsByFile`/`dynamicImports` record only what
 * stayed EXTERNAL (the import map's job), so an accidentally-bundled package is
 * invisible there — while every module rollup folded into the bundle appears in
 * `sources` (every artifact builds with `sourcemap: true`). A source under
 * `node_modules/` therefore proves an npm module was inlined; the package name
 * is the path segment after the LAST `node_modules/` (handles nested installs
 * and scoped packages).
 */
export function packagesInSourcemapSources(
  sources: readonly string[],
): string[] {
  const pkgs = new Set<string>();
  for (const source of sources) {
    const i = source.lastIndexOf("node_modules/");
    if (i === -1) continue;
    const rest = source.slice(i + "node_modules/".length);
    const parts = rest.split("/");
    const pkg = parts[0]!.startsWith("@")
      ? `${parts[0]}/${parts[1] ?? ""}`
      : parts[0]!;
    if (pkg) pkgs.add(pkg);
  }
  return [...pkgs].sort();
}

/** The subset of inlined packages NOT covered by the inline allowlist. */
export function offendingPackages(
  inlined: readonly string[],
  allowlist: ReadonlySet<string>,
): string[] {
  return inlined.filter((p) => !allowlist.has(p));
}

/**
 * Throws when any of a freshly built artifact's sourcemaps (`maps`, from
 * `artifactSourcemaps`) inlines an npm package outside `INLINE_PACKAGES`.
 * `read` returns a listed map's text.
 */
export async function assertNoVendoredStateInlined(opts: {
  dirName: string;
  maps: readonly string[];
  read: (name: string) => Promise<string>;
}): Promise<void> {
  const inlined = new Set<string>();
  for (const map of opts.maps) {
    const raw = await opts.read(map);
    // Fast path: no `node_modules/` substring anywhere ⇒ no npm module inlined
    // (spares the JSON.parse of multi-MB maps for the overwhelmingly common case).
    if (!raw.includes("node_modules/")) continue;
    const parsed = JSON.parse(raw) as { sources?: string[] };
    for (const pkg of packagesInSourcemapSources(parsed.sources ?? []))
      inlined.add(pkg);
  }
  const offending = offendingPackages([...inlined].sort(), INLINE_PACKAGES);
  if (offending.length === 0) return;
  throw new Error(
    `web-artifact ${opts.dirName} bundles npm modules outside the inline allowlist ` +
      `(INLINE_PACKAGES in web-artifacts/core/constants.ts): ${offending.join(", ")} — ` +
      `each inlined copy is a second module instance next to the vendored one (the ` +
      `React-context dual-instance bug class). Fix the externals rule regression ` +
      `(web-artifacts/core/externals.ts) — or, ONLY for a provably stateless package, ` +
      `extend INLINE_PACKAGES.`,
  );
}
