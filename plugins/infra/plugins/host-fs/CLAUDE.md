# host-fs

The one host-filesystem API: every read of an arbitrary path on the user's
machine (not a git ref, not an app data dir) goes through here. Contracts live
in `core/` (`defineEndpoint`), handlers in `server/` (`implement()`, plus one
raw byte-stream handler). There is no web barrel: consumers call
`useEndpoint(hostFsList, …)` / `fetchEndpoint` from `infra/endpoints` directly,
and build byte URLs with `hostFileUrl(path)`.

| Endpoint | Answers |
|---|---|
| `GET /api/host-fs/list?path` (`hostFsList`) | `ok {path, parent, entries, within?}` · `missing` · `denied` · `not-a-dir` · `unreadable-archive`. No path = home. |
| `GET /api/host-fs/stat?path` (`hostFsStat`) | `ok {path, parent, entry, within?}` · `missing` · `denied` · `unreadable-archive` |
| `GET /api/host-fs/complete?prefix` (`hostFsComplete`) | folder-only children of `dirname(prefix)` matching `basename(prefix)`, case-insensitive, capped at `HOST_FS_COMPLETE_LIMIT` (`truncated`) |
| `GET /api/host-fs/text?path` (`hostFsText`) | `ok {content, size}` · `too-large` (> `HOST_FS_TEXT_MAX_BYTES`, 2 MiB) · `binary` (NUL in the first 8 KB) · `missing` · `denied` · `not-a-file` · `unreadable-archive` |
| `GET /api/host-fs/raw?path` (`hostFsRaw`, `hostFileUrl`) | the bytes, streamed; `Range` (one range) → 206 / 416; 404 / 403 / 400 (a directory) / 422 (an unreadable archive member) |
| `GET /api/host-fs/volume?path` (`hostFsVolume`) | `ok {name, total, free}` · `missing` · `denied` |
| `POST /api/host-fs/open {path, reveal?}` (`hostFsOpen`) | `opened` · `in-archive` · `missing`; 403 off-origin, 501 off macOS |
| `POST /api/host-fs/extract {path}` (`hostFsExtract`) | `extracted {created, layout: single \| folder}` · `not-an-archive` · `missing` · `denied` · `unreadable-archive`; 403 off-origin |

Images get two more reads in the `image` sub-plugin: resized copies
(`GET /api/host-fs/image/resized`) and a folder's pixel sizes
(`GET /api/host-fs/image/sizes`). It reads files through `openHostFile`
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

`decodeTextBytes` (server barrel) is the one size + binary gate for decoding
file bytes as text; code-explorer's git-ref reads use it too.

## Security model

Recorded decision: [`research/2026-07-02-global-adr-single-instance-per-user.md`](../../../../research/2026-07-02-global-adr-single-instance-per-user.md)
— one instance per user, one trusted principal, no auth on localhost. The plan
this plugin implements: [`research/2026-10-02-apps-file-explorer-from-prototype.md`](../../../../research/2026-10-02-apps-file-explorer-from-prototype.md).

- **No path sandbox.** The server reads whatever the user account can read;
  **filesystem permissions are the boundary**, and hitting one is the typed
  `denied` state (e.g. `~/.Trash` without Full Disk Access).
- **Read-only, with two side effects.** `POST open` spawns macOS `open <path>`
  (or `open -R <path>` to reveal) through `infra/spawn`, the path one argv
  element (never a shell) and always absolute, so it cannot be read as a flag.
  `POST extract` writes an archive's members beside it — only NEW paths (a
  taken name gets a number, never overwritten), only under the archive's own
  folder (member names are normalised: no `..`, no absolute path; symlink
  members are not written), staged in a hidden sibling and renamed into place.
- **The exposure is other web pages in the user's browser, not the user.** A
  site must not be able to read `~/.ssh` through `localhost:9000`:
  - Cross-origin `fetch` reads are blocked by CORS (no endpoint sends CORS
    headers).
  - `POST open` and `POST extract` refuse (403) any request whose `Origin` is not `localhost` or
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

- Description: The one host-filesystem API: list / peek / stat / complete / text / raw / volume reads of any path the user account can read (filesystem permissions are the boundary; missing / denied / not-a-dir are typed results), POST open (Open with default app, Reveal in Finder) and POST extract (an archive beside itself, its single top-level entry as itself or several in a new folder), both refused unless the Origin is the app's own *.localhost.
- Server:
  - Uses:
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
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
    - `listHostPath`
    - `openHostFile`
    - `readHostPathText`
    - `resolveHostPath`
    - `serveHostPath`
  - Routes:
    - `GET /api/host-fs/list`
    - `GET /api/host-fs/stat`
    - `GET /api/host-fs/complete`
    - `GET /api/host-fs/text`
    - `GET /api/host-fs/raw`
    - `GET /api/host-fs/volume`
    - `POST /api/host-fs/peek`
    - `POST /api/host-fs/open`
    - `POST /api/host-fs/extract`
- Core:
  - Uses:
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
  - Exports (types):
    - `HostFsArchiveReason`
    - `HostFsCompleteResult`
    - `HostFsEntry`
    - `HostFsEntryKind`
    - `HostFsExtractResult`
    - `HostFsListResult`
    - `HostFsOpenResult`
    - `HostFsPeekResult`
    - `HostFsStatResult`
    - `HostFsTextResult`
    - `HostFsVolumeResult`
    - `HostFsWithin`
  - Exports (values):
    - `HOST_FS_COMPLETE_LIMIT`
    - `HOST_FS_PEEK_MAX_NAMES`
    - `HOST_FS_PEEK_MAX_PATHS`
    - `HOST_FS_TEXT_MAX_BYTES`
    - `hostFileUrl`
    - `hostFsComplete`
    - `hostFsExtract`
    - `hostFsList`
    - `hostFsOpen`
    - `hostFsPeek`
    - `hostFsRaw`
    - `hostFsStat`
    - `hostFsText`
    - `hostFsVolume`
    - `isBrowsable`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `code-explorer`
    - `infra/host-fs/image`
    - `infra/host-fs/zip`
    - `primitives/file-viewer`
- Sub-plugins:
  - **`image`** — Images on the host filesystem: GET resized (a copy with a long edge from a closed set, EXIF-rotated, never enlarged — JPEG, or WebP with transparency — made with sharp, cached host-wide and served…
  - **`zip`** — Zip as a host-fs archive format: a native reader of the zip central directory (zip64, UTF-8 / CP437 / Info-ZIP Unicode names, extended timestamps) registered through defineArchiveFormat, so a .zip…

<!-- AUTOGENERATED:END -->
