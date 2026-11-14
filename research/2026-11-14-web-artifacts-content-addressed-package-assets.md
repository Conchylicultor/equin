# Package assets at their own content-addressed URL

## Context

The demo's boot bar read 11 MB on some visits and 18 MB on others, and the user asked
why it grew. Measured on main (2026-11-14), a fresh browser counts 18.4 MB:

| part | MB (br, over the wire) |
|---|---|
| server code (worker tree) | ~2 |
| starting snapshot | 12.0 |
| PGlite: `pglite.wasm` 3.0, `pglite.data` 1.3, `initdb.wasm` 0.13 | 4.1 |

A warm visit (Reset demo) counts 12.0 MB, which is the snapshot alone. So the demo did not
grow; the two readings are cold and warm visits.

PGlite's bytes have not changed since Oct 26, yet a returning visitor downloads them again
whenever the vendor set changes (main built 7 sets on Nov 14). The reason:
`package-assets.ts` `placePackageAssets` hard-links each URL-fetched asset beside its vendor
chunk (`set.<h>/chunks/pglite.wasm`). The chunk keeps `new URL("./pglite.wasm", import.meta.url)`,
so:
- the page fetches it at `/artifacts/set.<h>/chunks/…`;
- the worker fetches it at `/artifacts/worker-tree.<h>/_vendor/chunks/…`.

Both URLs change with every vendor set. The gateway already serves `/artifacts/*` with
`immutable` and `.br` sidecars.

**Outcome:** each package asset is served at `/artifacts/<sha16>.<basename>/<basename>`
(its existing package-assets store entry). The URL changes only when the asset's bytes
change, and the page and the worker share it. A warm visit after a vendor-set change saves
4.1 MB. The ~2 MB of worker code is a separate, smaller issue, out of scope here.

## Design

1. **Rewrite the vendor output, not the source** (`core/internal/package-assets.ts`).
   - Replace `placePackageAssets` with
     `rewritePackageAssetUrls({ metafile, cwd, pin }) → string[]` (sorted entry names).
   - It reads the metafile to find which output holds which `node_modules` inputs with
     `urlAssetRefs`, and publishes each asset through the existing `ensurePackageAsset`,
     which now returns the entry name.
   - In each output `.js` it rewrites every matching `URL_REF_RE` literal (`"./x"`, `"x"`,
     `"../x"`) to `new URL("/artifacts/<entry>/<basename>", import.meta.url)`, the same
     absolute form `link.ts` already uses for plugin chunks.
   - It shifts later sourcemap segments on the same line by the length difference (UTF-16
     indices), using a pure helper `rewriteUrlRefs(code, mappings, refs)`.
   - It throws if one output's ref string points to two different contents.
   - No hard links into the set any more. Old cached sets keep working unchanged.
   - Rejected alternative: an esbuild `onLoad` source rewrite. It can only filter by path, so
     every `node_modules` input would go through JS.
2. **The vendor set names its assets** (`vendors.ts`).
   - `VendorSetMeta.packageAssets?: string[]` (optional, since old sets lack it).
   - `ensureVendorSet` fills it and drops the `precompressed` hand-off.
   - Helpers: `vendorAssetLinks(meta)` and `vendorSetPackageAssetPaths()` (reads every
     `set.*/meta.json`).
   - `packageAssetPath(name)` is the one way to build an entry path, so prune roots compare
     as equal strings.
3. **The pipeline links them** (`pipeline.ts`).
   - Pin the assets in the build lease on both vendor paths (built, or reused from fleet
     meta), and assert each entry's `meta.json` exists.
   - Push `vendorAssetLinks` into compose's `links`. The address dir is write-once and its
     names are content addressed; materialize copies the links for releases.
   - Exclude these names from `scanStagedModules`, as `assetDirs` already are.
4. **Prune** (`lease.ts`).
   - A package asset entry is a root while any dist links it (already the case through
     `served-dists`) OR any cached vendor set names it. Add `vendorSetPackageAssetPaths()` to
     `referenced` under the exclusive lock.
   - Without that, a reused set could outlive its asset and the worker would get a 404.
   - Unreferenced entries still age out under `PACKAGE_ASSETS_PRUNE_POLICY`.
5. **Docs:** in web-artifacts `CLAUDE.md`, rewrite "Vendor assets follow their module" and
   add the package assets to the lease and prune text.

Nothing changes in the gateway: `.data` is served as octet-stream, sidecars are negotiated
by path, and the immutable header is set by prefix. Editing `core/` changes
`builderSourceDigest`, so every vendor set rebuilds once. The asset entries already exist,
so nothing is recompressed.

## Tests

- **`package-assets.test.ts`**
  - `rewriteUrlRefs`: the three ref forms and minified code; unknown and `https:` refs left
    alone; mapping shifts on that line only, adding up when there are two literals; other
    lines byte-identical; the conflict throw.
  - A tiny esbuild fixture package with `new URL("./a.bin", import.meta.url)`: the output
    points to `/artifacts/<sha16>.a.bin/a.bin`, nothing is placed beside it, the entry has
    sidecars, the map still resolves past the literal, and a second run reuses the entry.
    This may need an `assetsRoot` parameter.
- **`lease.test.ts`:** an entry named by a set's meta survives past its age; one linked from
  a dist survives; an unreferenced old one is pruned.
- **`compose.test.ts`:** the asset link is added once, re-composing doesn't throw, and
  materialize copies the dir with its sidecars.

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts`, then
   `./equin build`.
2. On this worktree's `/demo` in the headless browser:
   - the boot still completes;
   - the vendor chunk names `/artifacts/6b290789f89aabf0.pglite.wasm/pglite.wasm`;
   - `curl -I` with `Accept-Encoding: br` gives `immutable` and `Content-Encoding: br`.
3. Change a vendor (or the builder digest), rebuild: the asset URL is unchanged. Run the
   demo e2e scripts `snapshot`, `persistence`, `no-leak`.
