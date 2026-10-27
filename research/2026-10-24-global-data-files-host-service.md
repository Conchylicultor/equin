# Data files: one host-agnostic file store for file-based apps (Prototypes in the demo)

Task: task-1792842805-6kzc6j. Wiki: subtrack "portable server code (server/ vs machine/)", block-323b766d-7ddf-4555-820a-80d82d6737f3. Previous session: research/2026-10-24-global-demo-pages-and-in-embed-app-switching.md.

## Context

Prototypes is still out of `agent-manager-demo`, because every read and write of its data goes straight to the computer's disk from server code. That code lives in `apps/prototypes/files` (shared, server and machine) plus `state` and `thumbnails`; `files` carries 12 `no-platform-api` debt exemptions. Four more things block it:

- Frames in the demo would load as blob URLs, which have no directory base, so relative `styles.css`, `data.js` and CSS `url()` break.
- `HTMLRewriter` (Bun only) is used in `files/core` and `files/shared`.
- Version history is a bare git repo per prototype.
- Thumbnails are rendered by Playwright.

The file explorer and later apps (wallpaper, Sonata covers, …) have the same problem.

**Outcome.** One generic file service, `DataFiles`, covers app-owned data dirs on every host: the real disk on the desktop, in memory in the browser worker (OPFS/IndexedDB later, same API).

- Prototypes runs in the demo on seeded prototypes: gallery with real thumbnails, canvas frames with working relative assets, picks, version history and restore.
- The file explorer is the second user, through an "App data" place.

**Decisions (user, 2026-10-24):**

- The demo store is in memory and resets on reload.
- Seeded prototypes must show real thumbnails.
- In the demo, compare with a `route:` mock answers `unresolved`.
- The service lives at `infra/paths/plugins/data-files`.
- `infra/host-fs` stays the desktop-only API for *arbitrary* host paths.

**Facts the plan relies on (checked):**

- The template's unpkg React block is commented out and opt-in (`prototypes/_template/index.html:52-62`), so it is not a demo blocker.
- Prototypes reach sibling files only through `<script src>`, `<link href>`, CSS `url()` and assigned `src`. The template forbids `fetch` of local files.
- `/artifacts/*` misses already 404 at the gateway (`gateway/proxy.go:210-217`). Every other miss falls back to the SPA shell.

## 1. The service: `infra/paths/plugins/data-files`

### `core/` (portable, pure)

- **`RelPath` brand.** `relPath()` / `joinRel()` throw `InvalidRelPathError` on an empty segment, `.`, `..`, `/`, `\`, NUL or a leading `/`. The API takes no absolute path.
- **Results are unions, so a miss is never an absorbable `null`:**
  - `StatResult` = `found` (a `FileEntry`, using `HostFsEntrySchema`'s field spellings from `host-fs/core/internal/endpoints.ts:27-55`) | `missing`;
  - `ListResult`, which tells a missing dir from an empty one;
  - `ReadResult` = `{ kind: "file", blob, entry }` | `missing`;
  - `RenameResult` = `renamed` | `target-exists` | `missing`.
- **Changes:** `DataChange` = `{ kind: "changed", paths }` | `{ kind: "rescan" }`.
- **Errors:** `LockBusyError`.
- **`Mount` interface:** `list`, `stat`, `read`, `write` (always atomic, parents implicit), `remove` (`recursive` must be explicit), `rename` (`ifAbsent`) and `withLock(key, fn)`. There is no `mkdir` and no `exists`.
- **Helpers:** `readText`, `copyTree`, `stageThenRename`.

### `server/` (`portable: true`)

- `DataFiles = defineHostService<DataFilesImpl>("data-files.store")`, using `server-core/core/host-service.ts`.
- `defineFileRoot({ id, dir, watch?, ledger? })` returns a `FileRoot`: a `Mount` plus `watch(onChange)`. The owning plugin declares it in its `server/`.
  - `dir` is a data-dir-relative string such as `"apps/prototypes"`. `paths/core` is Node-only, so roots need a portable string identity.
  - `watch` takes the extension filter and the reconcile interval.
  - `ledger` takes `{ id, label, under }`.
- Every mutation takes a required `writer: WriteOrigin` (`request-origin/core`).
- Lint: `DataFiles.get()` may only be called inside `data-files/**`. Consumers hold a `FileRoot`, so a plugin can only reach a root it declared.

### `machine/` (the desktop provider)

**Binding.**
- Each owner's `machine/` contributes `FileRootLocation(root, dataDir)`.
- At register time, assert that every root has exactly one binding and that `dataDir` matches `root.dir`. This replaces resolving through the data-dir registry, which is complete only after every owner's `data-dirs/` has loaded.

**Operations.**
- `read` uses `Bun.file` (streamed).
- `write` writes a temp file `.<name>.<uuid>.tmp`, then renames it.
- `rename ifAbsent` keeps `copyFolderOnce`'s semantics (`files/shared/template.ts:35-56`).
- `withLock` takes the **same** lock files as today (`_history/<id>.lock`, `_picks/<id>.lock`), so the CLI keeps interoperating. It tries `packages/flock`'s `flockTry`, then falls back to `waitForFlock`. That deletes the 25 ms poll in `files/shared/history/lock.ts:40-55`.

**Watch.**
- A root's `watch` spec becomes a `defineFileWatcher` registration (`infra/file-watcher`).
- It keeps the Background-catalog name `prototypes-files.tree`.
- The reconcile tick sends `{ kind: "rescan" }`.

**Ledger.**
- A write under `ledger.under` with an agent origin is recorded through `defineAgentWriteLedger`, the way `config_v2/machine/internal/file-store.ts:60` does.
- The id stays `prototype-picks`.

**CLI.** `diskMount(dataDir)` is exported for `cli/`, which boots no graph.

### `plugins/memory/server` (portable; the browser provider)

- Add `"!infra.paths.data-files.memory.**"` to `base-exclusions` (`plugin-meta/plugins/composition/core/config.ts:245-258`).
- Storage is `Map<root, Map<RelPath, { blob, mtimeMs, birthtimeMs }>>`. Directories are implicit, and `mtimeMs` is monotonic.
- `withLock` uses `packages/keyed-mutex`.
- `watch` merges each tick's mutations into one `changed` event. It never sends `rescan`, matching `config_v2/core/internal/store.ts:62-66`.
- `seedFiles(root, files)` is exported for the demo seed, following the precedent of `transcript-source/plugins/memory/server`.

### Enforcement

- **`data-files:roots-bound` check:** every `defineFileRoot` id has one `FileRootLocation` in a `machine/` barrel.
- **`data-files:root-owner` check:** a root's `dir` belongs to a data dir owned by the declaring plugin or one of its ancestors.
- **Existing checks also cover it:** `host-services:provider-placement` and `boundaries:portable-closure`.

### Tests

One conformance suite in `data-files/server/testing/`, run against both providers (a temp dir and memory). It covers:
- atomic write;
- `rename ifAbsent`;
- lock contention;
- watch after a write;
- missing vs empty dir;
- `RelPath` fuzzing, including decoded `%2e%2e`.

## 2. Portable HTML and hashing

**HTML.** Add `scanHtml(html, handlers)` (selectors `html`, `title` text, `meta`, `script`) and `rewriteStartTag(html, "html", fn)` to `infra/html-decode/core`, on `htmlparser2` (a new dependency there).
- `rewriteStartTag` splices by start and end index, so all other bytes stay untouched. That is the picked-document contract.
- Values still go through `decodeHtmlText` / `readHtmlAttr`.
- Callers to switch:
  - `files/core/option-source.ts:33`
  - `files/core/validate.ts:92,116,138`
  - `files/shared/list-metas.ts:65`
  - `files/shared/mint.ts:101`
  - `files/machine/internal/picked-document.ts:70`
- Then add `HTMLRewriter` to `boundaries/core/platform-apis.ts`. That also flags `apps/browser/plugins/proxy` and `apps/events/.../url-extract`: give them debt exemptions in the same change.

**Hashing.** `packages/string-hash` already uses `@noble/hashes`.
- Add `sha1Hex`, so the folder signature's `rev` stays byte-identical (`files/shared/folder-signature.ts:70`) and no open frame reloads on deploy.
- Add a bytes `sha256`, so thumbnail fingerprints (`thumbnails/server/internal/hash-dir.ts`) are unchanged and existing caches still hit.

## 3. Prototypes onto `DataFiles`

**Roots** (`apps/prototypes/server/internal/roots.ts`):
- `prototypesFiles` on `apps/prototypes`, with watch (the extensions and 30 s reconcile from `files/server/internal/watcher.ts:35-48`) and the `prototype-picks` ledger under `_picks`.
- Thumbnails declares its own cache root.

| Plugin | Change |
|---|---|
| `files` | `shared/{read-folder, folder-signature, list-metas, record-store, mint, template}` take a `Mount`. The server passes `prototypesFiles`, the CLI passes `diskMount(prototypesDir)`. `tree-path.ts` classifies `RelPath`s. `watcher.ts` keeps its signature gate (`:87-111`) over `root.watch`. The three raw file routes drop `needsMachine` (`core/prototypes.ts:164-202`) and move to a portable `server/internal/serve-file.ts` (`rawEndpointHandler`, `endpoints/core/implement.ts:193`), along with `picked-document`. `createPrototype` becomes `needsMachine`: minting reads the repo template and exists to launch an agent. Flip `server` to portable and delete the debt exemptions. |
| history | `PrototypeHistory = defineHostService<HistoryStore>("prototypes.history")` in `files/server`. The machine provider is today's git store, unchanged on disk. `files/plugins/snapshot-history/server` (portable, base-excluded) keeps content-addressed snapshots over `DataFiles` with the same `latest.json` stamp. One contract test suite runs against both providers. |
| `state` | `legacy-trash.ts` moves to `state/machine`. `prototypeExists` becomes `stat`. Flip to portable. |
| `thumbnails` | `server/` becomes portable: the state map, `syncThumbnails`, fingerprint and cache over its root, and the PNG route. Rendering goes behind `ThumbnailRenderer = defineHostService` (machine: Playwright, jobs, `requestDep`; browser: no renderer). A cache miss with no renderer is a new `ThumbnailStateSchema` arm, `{ status: "unavailable", message }`. Do not use `needsMachine` here: the gallery joins thumbnails in `useCombinedResources`, and one unavailable input blanks the whole gallery (`primitives/live-state/web/resource-utils.ts:73-77`). |
| demo thumbnails | Seeded prototypes show real thumbnails. Commit PNGs named by their content fingerprint next to the seed, rendered by the real Playwright renderer through a script (`./equin run …/e2e/render-demo-thumbnails.ts`). The seed writes them into the thumbnails root, so the normal cache-hit path answers `ready` with no demo branch. Restoring a seeded version has the same fingerprint, so it also hits. Check `demo:prototype-thumbnails-in-sync` fails the build when a seeded prototype or version has no PNG for its fingerprint, and names the command that fixes it. |
| `checkpoints` | Unchanged. It is not booted in the browser and contributes no reads (codegen roots only portable barrels). |
| `compare/route`, `present` | Without URL serving, `route-counterpart.tsx:153-178` answers `unresolved` ("needs the app served by URL"), and the open-in-new-tab actions are hidden. `embedUrl` is kept for `apps-core/tabs`. |
| `gallery` | The New prototype button reads `useMachineAvailability(createPrototype)`. |

## 4. Frame serving (generic, in `framework/browser-server`)

A Service Worker serves the worker's responses to frame documents, so frames get a real URL base. The page itself is never controlled by it, so in-page elements keep using `assetUrlOver` and blobs, unchanged.

- **Build.** `ensureBrowserHost` (`web-artifacts/core/internal/browser-hosts.ts:274-277`) also emits `frames-sw.js` (a classic script built from `browser-server/web/frames-sw.ts`) into the host's artifact dir. The stub exports `serviceWorkerUrl` next to `start()`.
- **Scope.** `/artifacts/<hostdir>/frames/<serverId>/`. A miss 404s at the gateway, and each build gets a fresh scope. Routing uses a per-`DemoScope` random server id, so two tabs never cross.
- **Transport.** `Transport` gets `frameBase: string | null`:
  - `""` for the page transport;
  - the scope for a browser server;
  - `null` when there is no Service Worker (frames show `unavailable`).
- **URL helper.** `frameUrlOver(transport, asset)` returns `ready | unavailable | unsupported`. It is exported from `infra/endpoints/web` and used by `canvas/web/context.tsx:501-528` and the probe frame.
- **Wiring.**
  - A `ToHost` arm `{ t: "attach", port }` (`browser-server/core/internal/port.ts:40-44`).
  - `attachFrameServing(worker, server)` registers the Service Worker and waits for its `activated` state, not `navigator.serviceWorker.ready`, because the page is outside the scope. It then hands each side one end of a `MessageChannel`.
  - A Service Worker revived from idle asks a client for a fresh port. With no answer within 5 s it returns a loud 503.
  - It answers GET and HEAD only, passes cross-origin requests through, and decodes router params, then validates them as `RelPath`.
- **DemoScope.** `demo-scope.tsx:55-80` runs `attachFrameServing` alongside the host boot and unregisters stale `/artifacts/*/frames/` scopes.

## 5. Demo seed and composition

**Seed data** lives in `apps/agent-manager/plugins/demo/data/prototypes/<id>/`, with `steps/vN/` overlays for history. Three small prototypes, with ids containing `demo`:
1. options (a choice and a color), `styles.css`, `data.js`, and an SVG referenced from CSS;
2. one with `mocks: exhibit:`;
3. one with `mocks: route:`, to show compare's `unresolved` arm.

Thumbnail PNGs sit next to them (§3).

**Loader.** `import.meta.glob(?raw)` inside a function, throwing when it finds nothing; precedent: `config_v2/plugins/bundled-layer/server/internal/bundled.ts:29-60`. The seed takes a reader as a parameter, so `bin/browser-host.test.ts` passes a disk reader. In order:
1. `seedFiles`;
2. `PrototypeHistory.checkpoint` per step;
3. picks;
4. `prototype_state` / `prototype_tags` rows;
5. thumbnail PNGs.

All of this runs before `onReady`.

**Composition.** The `agent-manager-demo` row (`config.ts:341-360`):
- drops `!apps.prototypes.**`;
- adds the positives `apps.prototypes.**` and `active-data.prototype.**`;
- updates its comment (`:325-328`).

Do **not** remove the `!active-data.prototype.**` negative from the shared `AGENT_MANAGER_ENTRY_POINTS` (`:69`), because the desktop agent-manager would gain the chips. A local positive wins over it. Then fix whatever the coverage guard reports.

## 6. File explorer (second user)

- The desktop explorer stays on `infra/host-fs` (`needsMachine`).
- A new portable read surface in `data-files/server`:
  - the live values `data-files.list`, `data-files.stat` and `data-files.text`, notified from each root's `watch`;
  - `GET /api/data-files/:root/raw?path=`.
- Roots opt in with `browse: "read"`.
- `FileRef` (`primitives/file-viewer/core/file-ref.ts`) gains a `{ source: "data", root, path }` arm.
- The explorer adds an "App data" place over `listFileRoots()`; the explorer names no root.
- The file explorer comes back into the demo afterwards: drop `!apps.file-explorer.**`, then fix what the guard lists.

## 7. Order (one session if it fits, else split at S6)

| Step | Content |
|---|---|
| S1 | `data-files`: core, server, machine, memory, checks, lint, conformance suite |
| S2 | HTML primitive, `sha1Hex` and bytes sha256, a parity script over every local prototype (output identical to `HTMLRewriter`, `rev` and fingerprints unchanged) |
| S3 | `files` on `Mount`; routes into portable `server/`; desktop regression |
| S4 | `PrototypeHistory`: git and snapshot providers, contract tests |
| S5 | `state` portable; thumbnails `ThumbnailRenderer` and the `unavailable` arm |
| S6 | Frame serving: Service Worker, `frameBase`, `frameUrlOver` |
| S7 | compare/present/gallery gating |
| S8 | Demo seed, thumbnail PNGs plus in-sync check, composition |
| S9 | File explorer "App data" place (may be its own session) |

## 8. Verification

- **Unit tests (`./equin test`):**
  - data-files conformance on both providers;
  - the `HistoryStore` contract on git and snapshot;
  - HTML parity, including picked-document output;
  - `rev` and fingerprint fixtures;
  - `frameUrlOver` arms;
  - the port `attach` test;
  - `demo-scope.test.tsx` with `frameBase` set and null.
- **Boot test:** `demo/bin/browser-host.test.ts` checks:
  - the `prototypes.*` reads load;
  - `GET /api/prototypes/<id>/styles.css` answers `text/css`;
  - the version file route works;
  - the picks PUT round-trips with a notify;
  - seeded thumbnails are `ready`;
  - `createPrototype` is unavailable.
- **New e2e, `agent-manager/demo/e2e/prototypes-in-demo.ts`:**
  - the gallery renders with real thumbnails;
  - a frame's computed style comes from `styles.css`, and the CSS `url()` SVG loads;
  - a color pick repaints;
  - the version stepper loads a `/versions/<sha>/` document;
  - restore creates a version and its thumbnail hits;
  - compare `route:` shows `unresolved`;
  - after a shift-reload, frames show a 404, not the app.
- **`no-leak.ts` extended:**
  - no `/api/prototypes*` request reaches the page origin;
  - every frame `src` is under `/artifacts/*/frames/`.
- **Desktop regressions:**
  - the canvas e2e scripts;
  - `files/e2e/touch.ts` (an out-of-band agent edit reloads one frame);
  - `./equin prototype new|list|log|checkpoint|restore`;
  - a CLI checkpoint interleaved with a picks PUT (lock interop);
  - `thumbnail-cover.ts`.
- **`./equin check`**, plus measurements:
  - worker size (23.1 MB) and warm ready time (~1.4 s) before and after;
  - a wiki status entry, and the next main task filed per the track instructions.

## Risks

- **Service Worker support.** It needs a secure context: Chrome treats `*.localhost` as secure, Safari and Firefox need checking. Firefox private windows have no Service Worker, which gives `frameBase: null` and frames that show `unavailable`.
- **Memory copies.** Port bodies are buffered, and the Service Worker hop copies them again. Keep seeded prototypes small.
- **Bundle size.** `htmlparser2` (~30 KB), the seed data and PNGs go into the worker bundle. Keep the PNGs small.

## Outcome (2026-10-25)

S1 through S9 landed in the working tree; nothing is pushed. The last build (build-1792881056-q16h9t) passed with every check green.

**What works**
- **data-files.**
  - core, server and machine halves, plus a memory provider.
  - Checks `roots-bound` / `root-owner` and the lint `no-direct-store`.
  - Conformance suite on both providers, with 71+ tests.
  - Read surface (S9):
    - `browse: { label }` roots;
    - the live values `data-files.roots/list/stat/text`;
    - the raw route `/api/data-files/:root/raw` (sandbox CSP, nosniff).
- **Prototypes runs in the demo.**
  - Three seeded prototypes, each with history, picks, tags and real thumbnails: 6 PNGs keyed by fingerprint, guarded by the `demo:prototype-thumbnails-in-sync` check.
  - Frames are served by a Service Worker under `/artifacts/<host>/frames/<serverId>/`, so relative CSS, JS and SVG resolve.
  - The `PrototypeHistory` service has two providers: git on the desktop, snapshots in the browser.
  - Thumbnails use a `ThumbnailRenderer` service and a new `unavailable` arm.
  - Compare hides the Real-app frame for a `route:` mock.
  - The New prototype button is gated.
- **HTMLRewriter replaced.** It is now htmlparser2 (`html-decode` `scanHtml` / `rewriteStartTag`), and `platform-apis` bans HTMLRewriter. Parity was verified over all 114 local prototypes.
- **string-hash.** Adds `sha1Hex` and a bytes `sha256`; `rev` and the fingerprints are unchanged.
- **File explorer.** A new "App data" place (`apps/file-explorer/app-data`) at `/files/data`; `FileRef` gains a `data` arm.

**Fixes after review** (9 findings, 8 real):
- read racing a remove now gives a typed miss;
- old ledger entries restore;
- in-process lock timeout, via an abort signal on `keyed-mutex`;
- Service Worker port re-request is single-flight;
- stale-scope cleanup is guarded by Web Locks;
- `seedFiles` goes through the root.

**Measurements**
- Worker size: 23,111,727 → 23,346,883 bytes (+1.0%).
- Warm ready time: 1.41–1.54 s at load ~19, against a 1.38–1.40 s baseline. Re-measure on a quiet host.
- e2e: prototypes-in-demo 27/27, no-leak 31/31, app-switch 24/24.

**Deviations**
- `active-data.prototype.**` stays out of the demo: composition-closure refuses a positive that contradicts the inherited negative.
- The thumbnail render script spawns a new CLI verb, `./equin prototype thumbnails <tree> --out <dir>`.
- The e2e lives in `apps/demo/e2e/`.
- `browse` is `{ label }`.
- App data has its own small browser rather than `FileBrowser`, which assumes host paths.

**Open**
- Desktop canvas e2e failures that also fail on main: narrow-header, size, remember, version.
- canvas-frames and color-option-verify fail too. They could not be compared on main (it refuses writes) and look like the same header layout problem.
- Pre-existing unit failure: `checkpoints/.../turn.test.ts`.
- The agent browser blocks Service Workers, so demo frames show `unsupported` there.
- On reload, an SPA URL ending in `/index.html` gets the gateway's 404 (`gateway/proxy.go`).
- `file-viewer.bytes` is still needsMachine, so data-root binary renderers don't work in the browser.
- Browse listings refresh only on `watch.extensions`.
- The file explorer is still out of the demo: places/git servers are host-only.
- Web Locks scope cleanup is untested across two real tabs.
