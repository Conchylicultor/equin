# What a first "Enter equin" costs a visitor

Status: measured on equin.ai (2026-11-17); one fix landed with this doc (the
snapshot's compression), the rest are proposals, each filed as its own task.

The website's live demo runs the Agent Manager's real server code in the
visitor's browser: a SharedWorker booting the `agent-manager-demo`
composition's portable server graph on PGlite, starting from a snapshot the
build took. Nothing downloads before the Enter equin click; after it,
everything the demo could ever need downloads before it starts.

## Method

`plugins/apps/plugins/website/plugins/landing/plugins/screenshot/e2e/enter-cost.ts`
(manual): a fresh browser context per run (empty HTTP cache and IndexedDB),
the homepage loaded, then the click, then "usable" = the boot screen gone and
no loader left. Network shaped by a CONNECT proxy the script runs — one token
bucket per direction shared by every connection, plus half the RTT each way —
never DevTools throttling. Bytes are CDP's `encodedDataLength` for the page and
for the SharedWorker (the harness's `tapSharedWorkerRequests`, which now
records them), cross-checked against the proxy's own count of TLS bytes. CPU is
not throttled (an M-series Mac in the foreground). Profiles as in
`2026-11-12-global-load-model-redesign.md` §12: fast 4G = 9 Mbps / 60 ms,
slow 4G = 1.6 Mbps / 150 ms.

## Before (equin.ai, build of 2026-11-17)

| profile | click → usable | wire bytes after the click |
|---|---|---|
| desktop (no shaping) | 3.8 s | 16.2 MB |
| fast 4G (3 runs) | **28.6 / 28.7 / 28.7 s** | 16.3–16.5 MB |
| slow 4G (1 run) | **133.8 s** | 16.3 MB (22.5 MB through the proxy: the homepage's film kept loading) |

What the 16.3 MB are (wire bytes, fast 4G run 3):

| what | wire | requests | encoding |
|---|---|---|---|
| worker: the starting snapshot `snapshot.bin` | **7.61 MB** | 1 | **none** |
| worker: PGlite `pglite.wasm` + `initdb.wasm` | 3.03 MB | 2 | br |
| page: the demo scope's web code | 2.50 MB | 781 | br |
| worker: the server graph's code (338 plugins) | 2.12 MB | 1,790 | br |
| worker: PGlite's share files `pglite.data` | 1.24 MB | 1 | br |

### Where the 28.7 s go (fast 4G)

Everything is serial — each part starts when the one before it ends:

```
 0.0 –  6.4 s  page: the scope's web code (2.5 MB, 781 modules); the
               SharedWorker is created only at 6.4 s (Chrome fetches its
               script behind the page's requests in flight — demo/scope's
               CLAUDE.md "No head start")
 6.4 –  7.3 s  worker: its own entry modules (stage `script`)
 7.3 – 14.6 s  worker: the snapshot, 7.8 MB uncompressed (stage `storage`)
14.6 – 23.9 s  worker: the server graph's modules, 1,790 requests discovered
               import by import: 2.1 MB in 9.3 s ≈ 1.8 Mbps of the 9 available
23.9 – 28.0 s  worker: PGlite's wasm + data (4.3 MB) — requested only by the
               database plugin's onReadyBlocking, after the whole graph loaded
28.0 – 28.5 s  wasm compile, Postgres start, the data dir restore, clock shift,
               migrations check, post-ready phases
```

The bytes alone would take 14.7 s at 9 Mbps; the serialization costs the other
14 s. On slow 4G the same chain is 134 s, of which the snapshot alone is 40 s.

CPU is small next to the network (desktop profile, same build): script 0.18 s,
storage 0.14 s, graph 2.8 s (of which `onReadyBlocking:database` 0.36 s:
wasm compile + Postgres start + restore), ready 0.04 s.

## Why each part is that size

### The snapshot — 7.8 MB, sent as is

- **Not compressed in transit.** web-artifacts' precompressed sidecars cover a
  list of extensions; `.bin` was not on it, so the gateway served the file
  identity (`Content-Encoding` absent; it is the only file > 20 KB the click
  sends uncompressed).
- **The database inside was already gzipped** (`dumpDataDir("gzip")`), so even
  compressing the file whole could not do much (7.97 → 4.21 MB brotli): the
  data dir is 24.5 MB raw, 2.39 MB gzip, **1.68 MB brotli**.
- What it holds (raw): the database 2.39 MB (gz; its 23.6 MB data dir is
  13 MB system catalog — the schema of every table, function and trigger of
  338 plugins — 7.4 MB user relations, 1 MB WAL); the header's JSON 1.5 MB, of
  which **1.33 MB is `icon-symbols`** (2,474 icon drawings: every code symbol
  in the default style plus every saved name in every style, the
  bundled-symbols warm-ups); `data-files` 3.08 MB (Prototypes' files and
  thumbnails, and Demo's home folder); `attachment-blobs` 0.88 MB (the
  before/after PNGs); transcripts 0.12 MB; config 0.15 MB.
- **1.3 MB of its 4.1 MB of blobs are exact duplicates** (67 unique of 78):
  a prototype's history snapshot holds every file of its first version
  (`photos.js` 487 KB twice, every `index.html` twice), and three 270 KB
  thumbnails share one size.
- None of the blobs is read by the first screen (Home): they are read when the
  visitor opens Prototypes, Files, or a before/after.

### PGlite — 4.3 MB brotli

`pglite.wasm` 10.1 MB raw / 2.97 MB br (Postgres compiled to WASM),
`pglite.data` 6.3 / 1.27 MB (the share directory: timezone data, encodings,
catalog bootstrap SQL, extension control files), `initdb.wasm` 0.13 MB br —
fetched although the database opens from a data dir and never runs initdb.
It is requested by `new PGlite()` in the database's `onReadyBlocking`, i.e.
after every server plugin's module has loaded.

### The server graph — 2.1 MB in 1,790 requests

The worker tree is one artifact per plugin barrel (714) plus their chunks,
loaded by `bootPluginGraph`'s load waves: each module's imports are discovered
only once it arrives, so the download is latency-bound (≈ 1.8 Mbps used on a
9 Mbps link). Route chunks (`2026-11-14-global-load-redesign-r1-module-imports-route-chunks.md`)
left worker trees out on purpose. All 338 plugins boot before the first screen,
whatever it reads; the largest are `database.migrations.bundled-source` (93 KB
br, the whole migration history) and `config_v2.bundled-layer` (77 KB br).

### The page's scope code — 2.5 MB in 781 requests

The demo's web plugins (`webScopedEntries`), loaded on Enter beside the host.
They download first and delay the SharedWorker's own script, so the worker is
created 6.4 s after the click on fast 4G (22.6 − 10.8 = 11.9 s on slow 4G).

## Fixed here

**The snapshot ships compressed.** Two changes:

- `database/pglite`'s `dump()` writes a plain tar (`dumpDataDir("none")`):
  the file is compressed whole for the wire, which compresses the data dir
  better than the gzip inside did, and the opener untars it without a gunzip.
- web-artifacts precompresses `.bin` (`precompress.ts`; a sidecar is still
  written only when it saves ≥ 5 %), so the gateway serves `snapshot.bin.br`.
  The snapshot dir's layout version moves to 3.

Measured on equin.ai's own snapshot, re-encoded: 7.97 MB → **3.62 MB brotli**
(q9, the build's quality; gzip fallback 5.78 MB). The raw file grows to 30 MB,
which only a client accepting neither br nor gzip downloads.

The boot screen's "MB downloaded" now counts the snapshot by its wire bytes
(its resource entry's `transferSize`), not by the decoded bytes it streams,
which would have shown 30 MB for a 3.6 MB download; the streamed bytes move the
progress fraction only.

Expected (fast 4G): the `storage` stage 7.2 s → ~3.3 s, **28.7 → ~24.8 s**;
slow 4G: 40 s → ~18 s of the snapshot, **134 → ~112 s**. The measured
numbers on equin.ai come with its next release; on a local build of the
`website` composition (no shaping) the click now downloads 12.7 MB instead of
16.3 MB, the snapshot 3.45 MB on the wire instead of 7.61 MB, and the demo
boots from it as before.

## Proposals (each filed as a sidequest)

Expected gains are for fast 4G, from the timeline above, each on its own.

1. **Overlap the worker's downloads instead of chaining them** (~−7 s).
   The snapshot, PGlite's wasm/data and the graph's code are independent; today
   the storage opens (snapshot) before the graph loads, and PGlite is asked for
   only after the graph loaded. Starting the snapshot fetch and
   `WebAssembly.compileStreaming` of PGlite (handed in as `wasmModule` /
   `fsBundle`, both PGlite options) at the worker's start would fill the
   ~7 Mbps the graph's waterfall leaves idle: the 3.6 + 4.3 MB arrive during the
   graph's 9 s.
2. **Load the worker's code without a waterfall** (~−6 s). 1,790 requests
   discovered import by import use 1.8 Mbps of 9. A flat list of the tree's
   modules fetched at once (the worker-tree link knows it), or chunking the
   worker tree like the route chunks, makes it bandwidth-bound: 2.1 MB ≈ 2 s.
3. **Start the host before the scope's web code** (~−4 s). The SharedWorker's
   script waits behind the page's 781 scope modules; creating the worker first
   (or loading the scope's code in fewer, larger chunks) lets the worker's
   chain start at the click instead of at 6.4 s.
4. **Leave out of the snapshot what the first screen does not read** (~−1.5 to
   −2 MB br, −1.5 s): deduplicate payload blobs (1.3 MB of exact duplicates),
   and ship blobs (prototype files and thumbnails, before/after PNGs, the
   home folder) as their own content-addressed files the host fetches on first
   read, not inside the file every visitor waits for. Reconsider the 2,474
   pre-drawn icons (1.33 MB raw, a few hundred KB br): the first screen draws
   dozens.
5. **Trim PGlite's payload** (~−0.5 to −1 MB): `initdb.wasm` is fetched
   though never run; `pglite.data`'s share files beyond what the demo's
   Postgres reads (timezone sets, unused encodings) could be cut in a custom
   build.
6. **Boot only what the first screen needs** (largest, longest): the 338
   server plugins and their 13 MB of catalog all boot before Home renders.
   Server plugins loaded on demand, as the web side is moving to, would bound
   the first screen's cost by what it reads — a redesign on the scale of the
   load redesign's R2.

Together 1–3 move the fast-4G critical path from "every part in a row"
(28.7 s) to roughly "the bytes at link speed" (~11–12 s after the snapshot
fix); 4–6 then shrink the bytes.
