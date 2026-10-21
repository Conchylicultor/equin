# Gateway: precompressed statics (brotli / gzip) for the web dist

## Context

The gateway serves every web-dist file identity-encoded. On `/demo` the
browser host alone is ~20 MB on the wire (pglite wasm 10.5 MB, data 6.2 MB,
host bundle 2.9 MB) where ~5 MB would do; the page's own ~2.5 MB of modules
and the 356 KB shell are the same. This matters most for the public website /
demo and mobile.

Cache headers are **already fixed in source**: `serveArtifact`
(`gateway/proxy.go`) sends `public, max-age=31536000, immutable` since
2026-10-12. The machine's running gateway was started 2026-10-11, so it simply
predates that — a gateway restart (`./singularity start`) after push picks it up.

## Measurements (Bun's native zlib, one core)

| file | gzip -9 | br q9 | br q11 |
|---|---|---|---|
| pglite.wasm 10.5 MB | 3.67 MB · 1.8 s | 3.28 MB · 5.1 s | 2.89 MB · 95 s |
| pglite.data 6.2 MB | 1.86 MB · 0.9 s | 1.30 MB · 1.2 s | 1.06 MB · 37 s |
| browser-host.js 2.9 MB | 0.63 MB · 0.1 s | 0.53 MB · 0.2 s | 0.48 MB · 6 s |

Over a whole dist's modules (2022 files, 39 MB): q9 6 s, q11 194 s, for a
body 6 % smaller. A first build with q11 for files ≤ 1 MiB took the full fleet
rebuild's artifact stage from ~120 s to 236 s. **q9 everywhere.**

## Design: compress once, at publish; negotiate at serve

Every dist file the gateway serves is content-addressed and write-once (store
artifacts, vendor sets, the global-CSS cache), so the right place to compress
is **when the bytes are published**, never per request (the gateway has no
brotli encoder in the Go stdlib, and re-gzipping 10 MB per request is waste).
This is the nginx `gzip_static` / `brotli_static` model.

### Build (web-artifacts, `core/internal/precompress.ts`)

- `precompressDir(dir)`: walks a dir, and for each compressible file (by
  extension: js, mjs, css, json, wasm, data, svg, html, txt, map,
  webmanifest; ≥ 1 KiB) writes `<file>.br` and `<file>.gz` beside it — async
  zlib (libuv threadpool, so the build's parallel stages are not blocked),
  brotli q9, gzip -9. A sidecar is kept only when it
  saves ≥ 5 %.
- **One publish primitive**: the three hand-rolled "write meta, rename tmp →
  store" copies (`store.ts publishArtifact`, `vendors.ts`, `global-css.ts`)
  become one `publishDir` that precompresses the tmp dir first, so the
  sidecars are part of the entry from the instant it exists — an entry is
  never visible without them, and nothing has to backfill.
- The composed shell files (`index.html`, `public/`) are precompressed in the
  staging dir after compose.
- `BUILDER_VERSION` bump: the global-CSS key does not hash the builder source,
  so a bump re-addresses it too (artifacts and vendors already re-address on
  any `core/` edit). One full fleet rebuild, as with any builder change.
- Consumers that list store dirs already filter by extension (`staged-verify`
  reads `.js`/`.mjs`; vendors list `.js`); `installAssets` / carry-forward copy
  every file of a CSS dir, which now includes its sidecars — wanted. Releases
  materialize store dirs with `cpSync`, so bundles carry the sidecars too.

### Gateway (`gateway/proxy.go`)

- `serveStaticFile(w, r, file)`: the one file-serve every static path uses
  (artifacts, other dist files, the plain shell). It picks `br` then `gzip`
  from `Accept-Encoding` (honouring `q=0`), and serves `<file>.br|.gz` when it
  exists with `Content-Encoding`, the ORIGINAL file's `Content-Type` (by
  extension; never sniffed off compressed bytes) and `Vary: Accept-Encoding`.
  No sidecar / not accepted → identity, exactly today's `http.ServeFile`.
  A `Range` request is always served identity (ranges over an encoded body
  are a footgun; the media that use Range are not compressible anyway).
- The head-spliced shell (`serveShellWithHead`, dynamic bytes) is gzipped on
  the fly when accepted (356 KB, ~ms), its ETag suffixed per encoding.
- Explicit `/index.html` keeps `http.ServeFile`'s redirect.

## Files

- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/precompress.ts` (new) + test
- `…/web-artifacts/core/internal/store.ts` (`publishDir`, `publishArtifact` async), callers in `vite-builder.ts`, `browser-hosts.ts`, `vendors.ts`, `global-css.ts`, `pipeline.ts`, `constants` (`BUILDER_VERSION`)
- `gateway/proxy.go`, `gateway/document_head.go`, `gateway/proxy_test.go`
- `gateway/CLAUDE.md`, `web-artifacts/CLAUDE.md`

## Verification

- `go test ./...` in `gateway/` (negotiation, q=0, Range, Vary, content type, shell gzip).
- `./singularity test` on web-artifacts (precompress unit test).
- `./singularity build`, then `curl -sI -H 'Accept-Encoding: br, gzip'` on the
  worktree's browser-host wasm/data/js, a module and `/` (needs the new gateway
  binary: after push, `./singularity start` restarts the gateway, then re-check
  on main's `/demo`).
