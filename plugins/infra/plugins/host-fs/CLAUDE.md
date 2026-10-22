# host-fs

The one host-filesystem API: every read of an arbitrary path on the user's
machine (not a git ref, not an app data dir) goes through here. Contracts live
in `core/` — the live values (`liveValue`, served by `machine/`) and the
endpoints (`defineEndpoint`, handled in `server/` by `implement()`, plus one
raw byte-stream handler). There is no web barrel: a surface reads the live
values with `useLive` (`hostFsListing`, `hostFsDirPeek`, `hostFsPathStat`,
`hostFsFileText`, `hostFsVolumeInfo` — *Live reads* below);
`fetchEndpoint` (`infra/endpoints`) is only for the endpoints that remain —
stat as a one-off validation, complete, and the open / extract / move
actions — and `hostFileUrl(path)` builds byte URLs.

| Endpoint | Answers |
|---|---|
| `GET /api/host-fs/stat?path` (`hostFsStat`) | `ok {path, parent, entry, within?}` · `missing` · `denied` · `unreadable-archive` |
| `GET /api/host-fs/complete?prefix` (`hostFsComplete`) | folder-only children of `dirname(prefix)` matching `basename(prefix)`, case-insensitive, capped at `HOST_FS_COMPLETE_LIMIT` (`truncated`) |
| `GET /api/host-fs/raw?path` (`hostFsRaw`, `hostFileUrl`) | the bytes, streamed; `Range` (one range) → 206 / 416; 404 / 403 / 400 (a directory) / 422 (an unreadable archive member) |
| `POST /api/host-fs/open {path, reveal?}` (`hostFsOpen`) | `opened` · `in-archive` · `missing`; 403 off-origin, 501 off macOS |
| `POST /api/host-fs/extract {path}` (`hostFsExtract`) | `extracted {created, layout: single \| folder}` · `not-an-archive` · `missing` · `denied` · `unreadable-archive`; 403 off-origin |
| `POST /api/host-fs/move {sources, destDir, resolutions?}` (`hostFsMove`) | `ok {destDir, results}` — one per source: `moved {from, to}` · `exists {from, to}` · `skipped` · `into-self` · `replaces-ancestor` · `same-dir` · `missing` · `denied` · `archive`; or, for the destination, `missing` · `denied` · `not-a-dir` · `archive`; 403 off-origin |

## Live reads (the reads above, kept fresh)

The folder, file and volume reads a surface renders are live values in
`core/` — list, peek, text and volume have ONLY the live form (their
endpoints are gone); `stat` keeps both (the endpoint for a one-off check, the
live `host-fs.stat` for a surface); `complete` and `raw` have no live form —
served by `machine/` (each `needsMachine`: under a transport with no computer behind
it the read is `unavailable`) and pushed from the shared dir hub
(`infra/file-watcher`'s `acquireDirWatch`) while read. A failure the endpoint
answered as a result kind is a declared refusal (`error.kind === "refused"`,
`error.code`): `invalid-path` (the endpoints' 400), `missing`, `denied`,
`not-a-dir` / `not-a-file`, `unreadable-archive` (message from
`hostFsArchiveReasonMessage`). Design:
research/2026-10-11-global-endpoint-reads-onto-live.md (B5).

A children-scope watch never opens a recursive one: it rides a folder-tree
watch already open above the folder (a checkout's), or opens a
single-directory watch of the folder alone (`infra/file-watcher`'s
`file-watcher.dir-entries`), so viewing `~` or `/` costs one handle. Every
value is read only once its watch is open (`whileSubscribed` is awaited first),
so nothing is re-read at arm time. A recursive watch is live by then; a
single-directory one is not yet — Bun arms it on its own thread a moment later
— so a change landing in that gap can be missed, and the value stays stale
until the next change (see `infra/file-watcher`'s CLAUDE.md).

| Value | Question → answer | Bound · freshness |
|---|---|---|
| `hostFsListing` (`host-fs.list`) | `{ path? }` (none = home) → pages of `HostFsEntry`, by name in CODE-POINT order; meta `hostFsListing.meta` → `{ path, parent, total, within? }` | key-range-paged (`limit` 500, `maxLimit` 10 000 without a viewport); `watchHostDir`, throttle 1 s; every page cut from one held listing per folder |
| `hostFsDirPeek` (`host-fs.peek`) | `{ path }` → `ok {children}` · `too-many {total}` · `archive` | ≤ `HOST_FS_PEEK_MAX_NAMES` names; `watchHostDir`, throttle 1 s; many folders: `useLive(v, [...])` |
| `hostFsPathStat` (`host-fs.stat`) | `{ path }` → `{ path, parent, entry, within? }` | one entry; `watchHostPath` |
| `hostFsFileText` (`host-fs.text`) | `{ path }` → `{ path, content, size }`; also refuses `too-large`, `binary` | ≤ 2 MiB, on demand; `watchHostPath` |
| `hostFsVolumeInfo` (`host-fs.volume`) | `{ path? }` → `{ path, name, total, free }` | snapshot (`refresh()`): free space has no change signal |

`watchHostPath(path, onChange)` (machine barrel) watches one path: its entry
in its folder (while the folder is not there, the nearest ancestor that is,
moving down as the path is created), a symlink's target too, and a folder's
own entries (a folder's stat follows them). `watchHostDir(path, onChange)` is
the folder twin: a children-scope watch of the folder, or — while it is not
there — of its entry, re-armed when it appears or goes; a folder inside an
archive watches the archive file. Both re-arm from a settled base: a re-arm
that fails is reported (`reportServerError`) and retried on the next event.
Not live: a change one level below a listed folder (a child folder's own
modified time and size, which only a watch of every child folder would hear)
and a symlinked child's target — the listing row keeps the values of the
folder's last read. `resolveOrRefuse` /
`refusalFor` (machine barrel) turn a spelling and an endpoint failure kind
into a read's refusal, for the sub-plugins serving reads of their own.

Images get two more reads in the `image` sub-plugin: resized copies
(`GET /api/host-fs/image/resized`) and a folder's pixel sizes (the
`host-fs.image-sizes` live value). It reads files through `openHostFile`
(server barrel), which opens a disk file or an archive member alike.

Rules every endpoint shares:

- **Paths** are absolute or start with `~` (expanded to home); `.`/`..` are
  collapsed. A relative path or a NUL byte is a 400.
- **Failure is a kind, never an empty value.** `missing` (ENOENT / ENOTDIR),
  `denied` (EACCES / EPERM) and `not-a-dir` / `not-a-file` are arms of the
  result, so a UI cannot render an unreadable folder as an empty one. Any other
  errno propagates (500).
- **An entry is what it resolves to.** A symlink to a directory is a `dir`
  (with `symlinkTarget`), to a file a `file`; `symlink` means a link that
  resolves to nothing readable. `other` is a socket / FIFO / device.
- **Hidden is presentation.** `hidden` flags dotfiles; they are always listed.
  macOS's `UF_HIDDEN` flag (e.g. `~/Library`) is not read.

## Archives browse like folders

A path may cross into an archive file: `~/Downloads/photos.zip/2022/a.jpg`.
`list` of the archive file lists its root, and `list` / `stat` / `text` /
`raw` read its members; `complete` and `volume` stay on disk. Plan:
[`research/2026-10-06-infra-host-fs-archive-browsing.md`](../../../../research/2026-10-06-infra-host-fs-archive-browsing.md).

- **Formats are plugins.** `defineArchiveFormat({ id, claims, index })`
  (server barrel) declares one, listed in its plugin's server `register`; a
  member it indexes carries its own `open()`. host-fs names no format — zip is
  the `zip` sub-plugin; tar / 7z are each one more.
- **Disk wins.** A path that exists on disk is read from disk (a real folder
  named `x.zip` is a folder); only a missing path is looked for inside the
  nearest claimed ancestor that is a regular file. Archives inside archives
  are not browsed (their members are `missing`).
- **Marks, not new kinds.** An archive file is a `file` entry carrying
  `archive: { format }`; `isBrowsable(entry)` (core) is the one "does this
  open like a folder?" test — a folder picker still tests `kind === "dir"`.
  A `list` / `stat` answer inside an archive carries `within { archive,
  format }`: the path is virtual, so Open with default app answers
  `in-archive` and reveal shows the archive itself.
- **Members are normalised.** `\` reads as `/`, `.` and empty segments drop,
  a name containing `..` is never listed, implied directories are
  synthesised, and macOS's `__MACOSX/` is hidden like a dotfile.
- **The index is cached, never stale.** Keyed by the archive's inode, size and
  mtime (16 archives / 500k members, LRU); built single-flight under the
  host-wide heavy-read slot; more than 200k members is `too-many-entries`.
- **Bytes.** A member stored uncompressed is a `Blob` window of the archive and
  honours `Range`; a compressed one streams whole (200, `Accept-Ranges: none`).
  `text` gates the uncompressed size before decompressing.
- **Extract is format-agnostic.** `extract` writes from the same cached
  index (`archiveTree`) and member `open()`s the reads use, so a new format
  extracts with no code here. One top-level entry (after dropping
  `__MACOSX/` and `.DS_Store`) is extracted as itself next to the archive;
  several go into a new folder named after the archive less its extension.

## Move asks before it overwrites

`move` never overwrites on its own: a source whose name is taken in `destDir`
answers `exists {from, to}` and stays put while the others move. The caller
asks the user and re-sends just those sources with `resolutions[from]`:
`replace` (the taken entry is set aside, restored if the move fails, removed
once it lands; refused as `replaces-ancestor` when it holds the source),
`keep-both` (the Finder's next free name — `freePath`, shared with `extract`)
or `skip`. Across volumes (`EXDEV`) the source is copied into a hidden staging
sibling, renamed into place, then removed. Comparisons (`into-self`,
`same-dir`) use real paths, a symlink source compared by its own location.

Dragging host paths between surfaces uses one payload (core):
`HOST_PATHS_MIME`, `writeHostPaths(dt, paths)`, `readHostPaths(dt)` →
`paths` · `absent` · `malformed`, and `hasHostPaths(types)` for `dragover`
(the data is unreadable until `drop`).

`decodeTextBytes` (server barrel) is the one size + binary gate for decoding
file bytes as text; code-explorer's git-ref reads use it too.

## Security model

Recorded decision: [`research/2026-07-02-global-adr-single-instance-per-user.md`](../../../../research/2026-07-02-global-adr-single-instance-per-user.md)
— one instance per user, one trusted principal, no auth on localhost. The plan
this plugin implements: [`research/2026-10-02-apps-file-explorer-from-prototype.md`](../../../../research/2026-10-02-apps-file-explorer-from-prototype.md).

- **No path sandbox.** The server reads whatever the user account can read;
  **filesystem permissions are the boundary**, and hitting one is the typed
  `denied` state (e.g. `~/.Trash` without Full Disk Access).
- **Read-only, with three side effects.** `POST open` spawns macOS `open <path>`
  (or `open -R <path>` to reveal) through `infra/spawn`, the path one argv
  element (never a shell) and always absolute, so it cannot be read as a flag.
  `POST extract` writes an archive's members beside it — only NEW paths (a
  taken name gets a number, never overwritten), only under the archive's own
  folder (member names are normalised: no `..`, no absolute path; symlink
  members are not written), staged in a hidden sibling and renamed into place.
  `POST move` renames paths the user dragged; it overwrites only on an explicit
  per-source `replace`.
- **The exposure is other web pages in the user's browser, not the user.** A
  site must not be able to read `~/.ssh` through `localhost:9000`:
  - Cross-origin `fetch` reads are blocked by CORS (no endpoint sends CORS
    headers).
  - `POST open`, `POST extract` and `POST move` refuse (403) any request whose `Origin` is not `localhost` or
    `*.localhost` — a missing or `null` Origin included — since a cross-site
    form POST is a "simple request" CORS does not stop.
  - `raw` serves `Content-Disposition: inline` with
    `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`,
    so an HTML or SVG file opened in a preview runs in an opaque origin and
    cannot script the app; and `Cross-Origin-Resource-Policy: same-site`, so a
    page outside `*.localhost` cannot pull a host file in through
    `<script src>` / `<img src>` (cross-site script inclusion).
- **Known gap, not widened here:** the gateway routes a request whose `Host`
  is not `*.localhost` to the default namespace when one is configured (the
  packaged single-app build), which leaves a DNS-rebinding path to every
  `/api/*` route. In dev (no default namespace) such a request 404s.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The host-filesystem readers other plugins build on: resolveHostPath, openHostFile (a disk file or an archive member), serveHostPath (the one byte server), readHostPathText / decodeTextBytes (the size + binary gate) and the archive-format registry (defineArchiveFormat). Its routes — stat / complete / raw reads of any path the user account can read, POST open / extract / move — are the machine half's, each needsMachine.
- Server:
  - Contributes:
    - `resource.declare` "host-fs.list"
    - `resource.declare` "host-fs.list:meta"
    - `resource.declare` "host-fs.peek"
    - `resource.declare` "host-fs.stat"
    - `resource.declare` "host-fs.text"
    - `resource.declare` "host-fs.version"
    - `resource.declare` "host-fs.volume"
  - Uses:
    - `infra/endpoints.HttpError`
    - `infra/host/host-read-pool.withHeavyReadSlot`
    - `infra/paths.HOME_DIR`
  - Exports (types):
    - `ArchiveFormat`
    - `ArchiveIndexResult`
    - `ArchiveMember`
    - `HostFileOpen`
    - `MemberBytes`
    - `TextBytesResult`
  - Exports (values):
    - `decodeTextBytes`
    - `defineArchiveFormat`
    - `inertHeaders`
    - `openHostFile`
    - `readHostPathText`
    - `resolveHostPath`
    - `serveHostPath`
  - Resources:
    - `host-fs.list` (keyed, window, notified)
    - `host-fs.list:meta` (push, notified)
    - `host-fs.peek` (push, notified)
    - `host-fs.stat` (push, notified)
    - `host-fs.text` (invalidate, notified)
    - `host-fs.version` (push, notified)
    - `host-fs.volume` (invalidate, snapshot)
- Machine:
  - Uses:
    - `infra/endpoints.implementMachine`
    - `infra/endpoints.machineHandler`
    - `network/live.serveValue`
  - Exports (types): `HostFsFailure`
  - Exports (values):
    - `hostPathVersion`
    - `listHostPath`
    - `refusalFor`
    - `resolvedOrNull`
    - `resolveOrRefuse`
    - `watchHostDir`
    - `watchHostPath`
  - Routes:
    - `GET /api/host-fs/stat`
    - `GET /api/host-fs/complete`
    - `GET /api/host-fs/raw`
    - `POST /api/host-fs/open`
    - `POST /api/host-fs/extract`
    - `POST /api/host-fs/move`
- Core:
  - Uses:
    - `infra/endpoints.assetPath`
    - `infra/endpoints.AssetPath`
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `FileVersion`
    - `HostFsArchiveReason`
    - `HostFsCompleteResult`
    - `HostFsDirPeek`
    - `HostFsEntry`
    - `HostFsEntryKind`
    - `HostFsExtractResult`
    - `HostFsFileText`
    - `HostFsListingMeta`
    - `HostFsListResult`
    - `HostFsMoveOutcome`
    - `HostFsMoveResolution`
    - `HostFsMoveResult`
    - `HostFsOpenResult`
    - `HostFsPathStat`
    - `HostFsPeekResult`
    - `HostFsStatResult`
    - `HostFsTextResult`
    - `HostFsVolumeInfo`
    - `HostFsVolumeResult`
    - `HostFsWithin`
    - `ReadHostPathsResult`
  - Exports (values):
    - `compareHostFsNames`
    - `FileVersionSchema`
    - `hasHostPaths`
    - `HOST_FS_COMPLETE_LIMIT`
    - `HOST_FS_MACHINE`
    - `HOST_FS_MOVE_MAX_SOURCES`
    - `HOST_FS_PEEK_MAX_NAMES`
    - `HOST_FS_TEXT_MAX_BYTES`
    - `HOST_PATHS_MIME`
    - `hostFileUrl`
    - `hostFsArchiveReasonMessage`
    - `hostFsComplete`
    - `hostFsDirPeek`
    - `hostFsExtract`
    - `hostFsFileText`
    - `hostFsListing`
    - `HostFsListingQuerySchema`
    - `hostFsMove`
    - `hostFsOpen`
    - `hostFsPathStat`
    - `hostFsRaw`
    - `hostFsStat`
    - `hostFsVersion`
    - `hostFsVolumeInfo`
    - `isBrowsable`
    - `readHostPaths`
    - `writeHostPaths`
- Cross-plugin:
  - Imported by:
    - `code-explorer`
    - `code-explorer/file-resolve`
    - `infra/host-fs/image`
    - `infra/host-fs/zip`
    - `primitives/file-viewer`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/archive/locate.ts`, `server/internal/archive/tree.ts`, `server/internal/complete.ts`, `server/internal/entry.ts`, `server/internal/extract.ts`, `server/internal/free-path.ts`, `server/internal/list.ts`, `server/internal/move.ts`, `server/internal/open-file.ts`, `server/internal/open.ts`, `server/internal/path.ts`, `server/internal/peek.ts`, `server/internal/raw.ts`, `server/internal/stat.ts`, `server/internal/text.ts`, `server/internal/volume.ts` (debt)
- Sub-plugins:
  - **`image`** — Images on the host filesystem: GET resized (a copy with a long edge from a closed set, EXIF-rotated, never enlarged — JPEG, or WebP with transparency — made with sharp, cached host-wide and served…
  - **`zip`** — Zip as a host-fs archive format: a native reader of the zip central directory (zip64, UTF-8 / CP437 / Info-ZIP Unicode names, extended timestamps) registered through defineArchiveFormat, so a .zip…

<!-- AUTOGENERATED:END -->
