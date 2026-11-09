# file-systems

One way to name and read a file, whichever file system holds it. A file is a
`FileLocation` — a path in one named file system — and every reader (the file
viewer's renderers, the Files preview, a tool card's thumbnail) hands that
location to the reads here and never asks which system it is in. Design:
[`research/2026-11-09-global-one-file-system-api.md`](../../../../../../research/2026-11-09-global-one-file-system-api.md)
(and the track's sub-page "Design: one file-system API, many file systems").

```ts
const pdf: FileLocation = { fs: "computer", path: "~/Downloads/boarding-pass.pdf" };
const note: FileLocation = { fs: "browser", path: "~/Documents/Notes/groceries.txt" };
const old: FileLocation = { fs: "checkout", checkout: "att-123", path: "plugins/a.ts", version: "HEAD" };

useFileText(note);        // web: loading | ok | unavailable (why) | error
useFileBytes(pdf);
useFileStat(pdf);         // missing / ready (read access, inside an archive) / undescribed
useAssetSrc(fileUrl(pdf)) // an <img>/<iframe>/<video> src, over the subtree's transport
```

## The file systems (a closed set)

| `fs` | What | Served by | Path |
|---|---|---|---|
| `computer` | the computer's disk | host-fs's `machine/` (desktop only, `needsMachine`) | absolute, or `~`-rooted; `.`/`..` collapsed; may cross into an archive (`~/x.zip/a.jpg`) |
| `browser` | a browser host's own storage, laid out like a home folder | data-files' in-browser store (`data-files/plugins/memory`, browser hosts only) | `~`-rooted; the home's own tree (`~/Documents/…`) beside the apps' folders under the hidden `~/.equin/` at their data dir (`~/.equin/apps/prototypes/…`), the folders above them implied by the roots there are |
| `checkout` | one checkout's files, on disk now or AS OF `version` (a git ref: `HEAD`, `main`, a sha) | code-explorer's `machine/` (`needsMachine`) | relative to the checkout's root; `checkout` is the workspace id the code reads take (an attempt id, `main`, `self`, an absolute root) |

The set is closed (`FileSystemKind`): both runtimes name it, and each system's
reads are declared here, in `core/` — `files.<fs>.stat` (not for a checkout),
`files.<fs>.text`, `files.<fs>.bytes` and `GET /api/files/<fs>/raw`. The
system's own plugin serves them. A system this host cannot run is **absent, not
broken**: its declarations are `needsMachine`, so under a transport with no
computer behind it (the in-browser demo) a read of a computer or checkout file
is `unavailable` before any request, and a browser file is the in-browser
host's to answer — never the page's server's (no-leak rule 1). Adding a file
system (Google Drive) is a new row: its declarations here, its server serving
them, and the web hooks' dispatch.

## The reads

- **Refusals**, the same codes on every system: `invalid-path`, `missing`,
  `denied`, `not-a-file`, `too-large` / `binary` (text), `unsupported` (an
  unreadable archive member, a version of a non-checkout).
- `text` is capped at `FILE_TEXT_MAX_BYTES` (2 MiB) and binary-sniffed (a NUL in
  the first 8 KB); `bytes` at `FILE_BYTES_MAX` (64 MiB); both on demand,
  invalidated by the server while read (a watch of the path, the checkout's
  refs for a named version).
- `raw` serves any file inert (`nosniff`, `sandbox` CSP but for a PDF, whose
  viewer refuses a sandboxed document; same-site only), with `Range` on the
  computer's disk and a checkout's working tree.
- `opensNatively(location)` — only the computer's disk hands a file to the
  computer's own apps (Open with default app, Reveal in Finder).

## Folders (what a browser reads and does)

The systems with folders a person browses are `BrowsableFileSystem` —
`computer` and `browser` (a checkout is read file by file). Each declares, in
`core/` (`internal/folders.ts`), the same folder reads, served by the
system's own half:

- `files.<fs>.list` — a folder's entries, key-range-paged by name in
  code-point order, its `{ path, parent, total, within? }` the meta sibling;
  read with `useFolderListing(fs, path)` (web). Re-sort with
  `compareFileNames`; `isBrowsable(entry)` is the "opens like a folder" test
  (a folder, or an archive file).
- `files.<fs>.peek` — a folder's child names, capped (`FILE_PEEK_MAX_NAMES`):
  `dirPeekOf(fs)`.
- `files.<fs>.stat` answers the resolved `path` and `parent` too:
  `fileStatOf(fs)` (a path bar's validation).
- `POST /api/files/<fs>/move` — the Finder's move (never replacing unless a
  per-source resolution says so; `exists` until then): `useFileMove(fs)`.

What a system can do beyond that is data, `FILE_SYSTEMS[fs].capabilities`
(`move`, `archives`, `openNative`, `completions`, `volume`, `images`), and a
browser offers a control only for what its system has. The operations only the
computer's disk has are declared only for it — there is no declaration to
call for another system: `computerFileCompletions`, `computerVolume`,
`computerFileOpen` (Open with default app, Reveal in Finder),
`computerFileExtract`, `handOffComputerFiles` (the OS drag of real files),
and its images (`internal/images.ts`): `computerImageSizes`
(`files.computer.image-sizes`, a folder's upright pixel sizes, paged like its
listing) and `computerImageResized` (`GET /api/files/computer/image/resized`,
a copy with a long edge from `RESIZED_EDGES`; its asset is
`computerResizedAsset(path, px, version)`), served by host-fs's `image`
sub-plugin. `MACOS_FILES_AND_FOLDERS_SETTINGS` is the link that undoes a
`macos-privacy` read access.

`useFolderListing(fs, path, { limit? })` reads every page (up to
`FILE_PEEK_MAX_NAMES`) by default; a smaller `limit` is a window that grows
with `loadMore` (the folder picker's "Show more").
Moving between two file systems is not offered yet (D22c): a drop of another
system's files says so.

**Which systems are here** is `files.systems` (`useFileSystems()`): the half
that serves a system contributes `FileSystemProvided(fs)` (this plugin's
`server/`) — host-fs's machine half `computer`, the in-browser store
`browser`. A system this host does not serve is absent: Files lists no place
of it and opens none of its folders. Boot-preloaded and kept (it is fixed per
build), so Files' Home never waits on it.

**Drag payload.** `FILE_LOCATIONS_MIME`: `{ fs, entries: { path, kind }[] }`
(`writeFileLocations` / `readFileLocations` / `hasFileLocations`) — one
system per drag.

**The browser's home.** `~` of the `browser` system is a home folder like the
desktop's: the home's own tree (`~/Documents`, what the demo's seed writes
through `writeBrowserHomeFiles`) beside the hidden `~/.equin/` holding every
app's data dir. Its home is its root, so its `~` stands for `/`
(host-account's `absolutePath` / `displayPath` take a home of `/`).

**Every reader is on it.** host-fs declares no reads of its own any more
(no `core/`): the folder picker (`fs` prop), folder links, browser
recordings, the image viewer's ← / → set and its thumbnails, Files and the
file viewer all name a file system and read through here.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: One read of a file in any file system: useFileText, useFileBytes and useFileStat take a FileLocation and read that system's live value (the computer's disk, the browser's storage, a checkout), so a reader never branches on where a file lives; a system this host cannot run is `unavailable`, nothing read. useFileSystems reads which systems this host serves (files.systems), useFolderListing(fs, path) a folder's pages and meta, and useFileMove(fs) one system's move as one mutation shape. Which file systems this host serves: FileSystemProvided(fs), contributed by the half serving a system's reads, and the files.systems value listing them (fixed per build) — what a browser reads to leave out a system nobody answers here.
- Server:
  - Contributes: `resource.declare` "files.systems"
  - Uses: `network/live.serveValue`
  - Exports (values): `FileSystemProvided`
  - Resources: `files.systems` (push, fixed, whole: the closed set of file systems, at most one entry each)
- Web:
  - Uses:
    - `infra/endpoints.useEndpointMutation`
    - `network/live.useLive`
  - Exports (types):
    - `FileBytesState`
    - `FileBytesUnavailable`
    - `FileStatState`
    - `FileSystemsState`
    - `FileTextState`
    - `FileTextUnavailable`
  - Exports (values):
    - `fileBytesUnavailableMessage`
    - `fileTextUnavailableMessage`
    - `useFileBytes`
    - `useFileMove`
    - `useFileStat`
    - `useFileSystems`
    - `useFileText`
    - `useFolderListing`
- Core:
  - Uses:
    - `framework/product-name.LEGACY_IDS`
    - `infra/endpoints.assetPath`
    - `infra/endpoints.AssetPath`
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
    - `infra/endpoints.MachineFeature`
    - `network/live.liveValue`
    - `packages/list-bound.cappedList`
    - `packages/list-bound.wholeList`
  - Exports (types):
    - `BrowsableFileSystem`
    - `DirPeekValue`
    - `DraggedFile`
    - `DraggedFiles`
    - `FileArchiveReason`
    - `FileCompletions`
    - `FileDirPeek`
    - `FileEntry`
    - `FileExtractResult`
    - `FileListingMeta`
    - `FileLocation`
    - `FileMoveOutcome`
    - `FileMoveResolution`
    - `FileMoveResult`
    - `FileOpenResult`
    - `FileReadAccess`
    - `FileStat`
    - `FileStatValue`
    - `FileSystemCapabilities`
    - `FileSystemInfo`
    - `FileSystemKind`
    - `FileText`
    - `FileVolume`
    - `FileWithin`
    - `FolderImageSize`
    - `ImageSize`
    - `ReadFileLocationsResult`
    - `ResizedEdge`
  - Exports (values):
    - `archiveReasonMessage`
    - `BROWSABLE_FILE_SYSTEMS`
    - `browserDirPeek`
    - `browserFileBytes`
    - `browserFileListing`
    - `browserFileMove`
    - `browserFileRaw`
    - `browserFileStat`
    - `browserFileText`
    - `checkoutFileBytes`
    - `checkoutFileRaw`
    - `checkoutFileText`
    - `compareFileNames`
    - `computerDirPeek`
    - `computerFileBytes`
    - `computerFileCompletions`
    - `computerFileExtract`
    - `computerFileListing`
    - `computerFileMove`
    - `computerFileOpen`
    - `computerFileRaw`
    - `computerFileStat`
    - `computerFileText`
    - `computerImageResized`
    - `computerImageSizes`
    - `computerResizedAsset`
    - `computerVolume`
    - `contentTypeOf`
    - `dirPeekOf`
    - `FILE_BYTES_MAX`
    - `FILE_COMPLETE_LIMIT`
    - `FILE_LOCATIONS_MIME`
    - `FILE_MOVE_MAX_SOURCES`
    - `FILE_PEEK_MAX_NAMES`
    - `FILE_SYSTEMS`
    - `FILE_TEXT_MAX_BYTES`
    - `FileArchiveReasonSchema`
    - `FileCompletionsSchema`
    - `FileDirPeekSchema`
    - `FileEntrySchema`
    - `FileExtractResultSchema`
    - `FileListingMetaSchema`
    - `FileListingQuerySchema`
    - `FileLocationSchema`
    - `FileMoveOutcomeSchema`
    - `FileMoveResolutionSchema`
    - `FileMoveResultSchema`
    - `FileOpenResultSchema`
    - `FileReadAccessSchema`
    - `fileStatOf`
    - `FileStatSchema`
    - `fileSystemsServed`
    - `FileTextSchema`
    - `fileUrl`
    - `FileVolumeSchema`
    - `FileWithinSchema`
    - `FolderImageSizeSchema`
    - `handOffComputerFiles`
    - `hasFileLocations`
    - `ImageSizeSchema`
    - `isBrowsable`
    - `isBrowsableFileSystem`
    - `isResizableName`
    - `locationKey`
    - `locationName`
    - `MACOS_FILES_AND_FOLDERS_SETTINGS`
    - `opensNatively`
    - `parseEdge`
    - `readFileLocations`
    - `RESIZABLE_EXTENSIONS`
    - `RESIZED_EDGES`
    - `resizedVersion`
    - `sameLocation`
    - `snapEdge`
    - `writeFileLocations`
- Cross-plugin:
  - Imported by: 24 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives` ×9
    - `apps` ×5
    - `conversations` ×4
    - `infra` ×3
    - `active-data/folder-link`
    - `code-explorer`
    - `debug/browser-recordings`

<!-- AUTOGENERATED:END -->
