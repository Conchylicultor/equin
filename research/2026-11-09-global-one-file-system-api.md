# One file-system API for Files and every viewer

Task: task-1794184535-l1s405 (attempt att-1794184536-w9oj3z). Track: "apps running in the browser" (wiki block-d04c6c0d-56fd-49f2-88f4-914e059cc83b); the same design is the track's sub-page "Design: one file-system API, many file systems". Session decision: D22 (block-e48cf036-58bd-4faa-802d-40037ef5fe1a).

Status: design approved (D22a–d); sessions 1 and 2 implemented (outcomes at the end), session 3 next.

## Context

The Files app (`apps/file-explorer`) and the file viewer (`primitives/file-viewer`) sit on two unrelated file systems:

- **`infra/host-fs`**: absolute paths on the computer's disk, desktop only (every read is `needsMachine`). Files' real browser is built on it: listing, peek, stat, path completion, volume, move, extract, open in Finder, drag payloads, archive browsing (`~/x.zip/a.jpg`).
- **`infra/paths/data-files`**: per-app "file roots" (`defineFileRoot`, 6 roots), a folder under `~/.equin/` on the desktop and an in-memory tree saved to IndexedDB in the browser host. Files shows the roots declared `browse` on a separate, simpler, read-only "App data" page. Only one root is `browse`: Files' own **Documents** (`apps.file-explorer.documents`), added only so the demo has files to show.
- **`FileRef`** (file-viewer core) is a union over `host` / `workspace` / `data`. Every reader switches on the arm (text, bytes, URL, revision, watch: about 25 switch sites), and PDF and media accept only `host`, so the demo says "No preview".

The user (2026-11-09): "Why do we have app data in the first place? This feels hacky. I don't see why apps should define extra data. I would expect the file reader to support arbitrary file systems, so this can be expanded to Google Drive and other services. The virtual browser file system is just one of those. All are rendered the same way."

## The user experience (the aspiration)

```ts
// Anywhere: a file is a location in a named file system.
const loc: FileLocation = { fs: "computer", path: "~/Downloads/boarding-pass.pdf" };
const loc2: FileLocation = { fs: "browser", path: "~/Documents/lisbon/notes.md" };
const loc3: FileLocation = { fs: "checkout:att-123", path: "/plugins/a.ts", version: "HEAD~1" };

<FileView file={loc} />                        // every viewer, for every file system
useLive(fileListing, { at: { fs, path } })     // one listing read, whichever system
<FileBrowser at={loc} />                       // Files: one browser for all of them
```

A Google Drive plugin adds one provider (`defineFileSystem({ id: "gdrive", … })` plus its implementation). Files, the path bar, Places, the preview pane, and every viewer then work on Drive with no edit outside that plugin. On a host that can't run a file system (the computer's disk in the browser demo), that file system is **absent**: it is not in Places, and a link to one of its files says "Not available in the browser version". It is never broken.

## Decisions in this design

1. **One API, `infra/paths/plugins/file-systems`.** It owns the location type, the declaration of a file system, the generic reads and writes, and the registry of providers. Consumers name only the generic API (collection-consumer separation). The umbrella is `infra/paths`, next to data-files, not a new top-level `infra/` entry.
2. **A file system is declared portably and implemented per host**, the same pattern as `defineFileRoot` + `FileRootLocation` today:
   - `defineFileSystem({ id, label, icon, home?, capabilities, needs? })` sits in the owning plugin's portable `server/`. It is data, so every host and the browser know it exists and what it can do.
   - The implementation (`FileSystemProvider`) is contributed by whichever half can run it: the computer's disk from host-fs's `machine/`, the browser storage from a browser-host plugin, later Google Drive from its integration.
   - `files.systems` (boot-preloaded live value) lists every declared system with `available: true | { needs }`. A declared system with no implementation on this host is `unavailable`, with the declared reason. This is what "absent, not broken" reads from.
3. **Apps' own files are folders in a file system, not a second kind of file system.** This answers the user's question:
   - An app still needs a place to keep its files on every host: prototypes, the wallpaper, caches. `defineFileRoot` stays as the **app's own write API**: scoped to its folder, atomic writes, locks, the agent-write ledger, and watches.
   - A root no longer defines anything a user browses. It **resolves to a folder in the host's home file system**: `~/.equin/apps/prototypes` on the computer, and the same path in the browser storage file system.
   - The `browse` flag, the `data-files.roots/list/stat/text/raw` reads, and the **App data page are deleted**. On the desktop, Prototypes' files are where they already are on disk (`~/.equin/apps/prototypes`, a hidden folder shown with "Show hidden"). An app that wants a sidebar entry contributes an ordinary **Place** pointing at its folder.
4. **The browser storage is a whole file system with a home, laid out like the desktop's.** `~` is its root. App folders live under the hidden `~/.equin/…`, exactly where the desktop keeps them, and the user's own files sit beside them. Files' index then opens on Home in the demo too: there is no "first place this host has" redirect, and no App data fallback.
5. **The Documents root is deleted.** In the demo, Documents is just `~/Documents` in the browser file system, seeded at build time through the generic write path. On the desktop, `~/Documents` is the real folder. Files no longer owns a data dir.
6. **A checkout is a file system with versions.** The `workspace` arm becomes `checkout:<workspace id>` (instance-parameterised, like a future `gdrive:<account>`). Paths are checkout-relative, and `version` is a git ref. It is read-only, desktop only, served by code-explorer. Today it serves images only through its raw route. Under the generic route it serves any file, so PDF and media in a checkout preview too.
7. **Viewers never look at which file system a file is in.** `FileRef` becomes `FileLocation`. Text, bytes, the URL, revision and watch each go through one generic read. PDF and media are gated on extension only. The "unreadable host file" gate (macOS privacy) becomes the generic `denied` refusal, which carries the provider's own fix (a settings link).
8. **Operations are capabilities, and the UI shows only what a file system supports.** `capabilities` is declared data:
   - `write`, `mkdir`, `rename`, `move`, `trash` / `remove`
   - `openNative` (Open with default app, Reveal in Finder)
   - `archives` (browse into a zip, Extract)
   - `versions`, `completions` (path bar), `volume` (storage meter)

   An operation the system lacks has no button. The generic endpoint refuses it as a type, never as a 500. Moving across file systems is **out of scope** for now (refused `cross-file-system`). Copying is the later primitive.
9. **host-fs stays the computer's disk implementation.** Its tuned internals stay in `machine/` and `server/` and are reused as they are: held listings patched in O(changed), dir watches, archive indexes, `openHostFile`, `serveHostPath` with Range. Its `core/` reads (`hostFsListing`, `hostFsFileText`, `hostFsMove`, …) are **deleted** once every web consumer reads the generic values. That makes the old spelling impossible to write rather than linted. `user-path` / `blocking-fs` are untouched.

## The API (`infra/paths/plugins/file-systems`)

### `core/`

- `FileSystemId`, a branded string: `"computer"`, `"browser"`, `"checkout:<ws>"`.
- `FileLocation { fs: FileSystemId; path: FsPath; version?: string }`. `FsPath` is absolute in its system, or `~`-relative for a system with a home. `.` and `..` are collapsed, and NUL or a relative path is `invalid-path`, the same rules as host-fs today.
- `FileEntry`: host-fs's `HostFsEntry` shape, which data-files already copies (`name, kind, size, mtimeMs, birthtimeMs?, hidden, symlinkTarget?, archive?`). `within?` for a path inside an archive.
- `FileSystemCapabilities`, and `FileSystemInfo { id, label, icon, home?, capabilities, available }`.
- `locationKey`, `locationName`, `fileExtension`, and `locationForPath(context, path)`, which replaces `fileRefForPath`.
- **Live values.** Each is the host-fs one generalised, and each takes `{ at: FileLocation }`:
  - `files.systems`, boot-preloaded;
  - `files.list`, key-range-paged by name, with meta `{ total, parent, within? }`;
  - `files.peek`, `files.stat`, `files.text` (2 MiB, binary-sniffed), `files.bytes` (moved from file-viewer);
  - `files.complete` (needs `completions`) and `files.volume` (needs `volume`).
- **Refusals.** The host-fs set (`invalid-path`, `missing`, `denied` + `fix?`, `not-a-dir`, `not-a-file`, `too-large`, `binary`, `unreadable-archive`), plus `unavailable-file-system { needs }`.
- **Writes** (endpoints):
  - `files.move`, which keeps host-fs's per-source results and conflict resolutions;
  - `files.rename`, `files.mkdir`, `files.trash`;
  - `files.write` (upload, and the seed);
  - `files.open` (`openNative`), `files.extract` (`archives`).

  Each is refused at compile time when a capability is missing, and at runtime (`unsupported`) as the backstop.
- `fileUrl(loc): AssetPath` over ONE raw route, `GET /api/files/:fs/raw?path&version`, with Range. Every system's bytes go through the transport, so no-leak rule 1 holds by construction.
- **Drag payload.** `FILE_LOCATIONS_MIME` (host-fs's `HOST_PATHS_MIME` generalised). The `DownloadURL` entry is only for a system with `openNative`.

### `server/` (portable)

- `defineFileSystem(spec)` and the `FileSystems.Provide(fs, impl)` contribution.
- **Boot check**: at most one implementation per declared system per host. An implementation of an undeclared system fails boot.
- The generic serve calls for every value above. Each dispatches to the provider and leaves paging and watching to the provider:
  - `list(path, range)`, `stat`, `open(path, range?)` (bytes + size + mime), `revision(path)`;
  - `watchDir(path, onChange: entries{names} | all)`, `watchPath`;
  - each optional op typed by its capability.
- **Held listing.** The O(changed) held-listing logic is lifted out of host-fs into a generic helper, so every provider gets one-readdir-then-patch for free.
- **Availability per tuple.** A read of a system with no implementation here answers `unavailable` with the declared `needs`. This needs one small live extension: `needsMachine` derived from the tuple (`(q) => systemNeeds(q.at.fs)`), so `useLive` returns `unavailable` before any request, as a static `needsMachine` does today. The declaration is what makes it typed, per the track's "declared in the server API" rule.

### The providers at the end of the work

| System | Declared in | Implemented in | Home | Capabilities |
|---|---|---|---|---|
| `computer`: the computer's disk | host-fs `server/` | host-fs `machine/` (desktop only) | the account's home | everything: write, mkdir, rename, move, trash, openNative, archives, completions, volume |
| `browser`: the browser storage | file-systems' `plugins/browser-storage` | the same plugin (portable, browser hosts only). It absorbs `data-files/plugins/memory`: one tree, saved to the host's IndexedDB `data-files` store | `/` | write, mkdir, rename, move, trash/remove. No openNative, archives or volume at first |
| `checkout:<ws>`: one checkout, any git ref | code-explorer `server/` | code-explorer `machine/` | none (root `/`) | read-only, versions |
| later: `gdrive:<account>` | integrations/google-drive | its server | My Drive | per Drive's API |

`data-files` keeps the app-folder API (`defineFileRoot`, `Mount`, lock, ledger, watch). Each root resolves to a location in the host's home system: the desktop binding is unchanged on disk, and the browser binding is `~/.equin/<dir>` inside `browser`. The `DataFiles` host service becomes a thin layer over the home system's provider, so the browser has one tree, not two.

## Inventory: what changes, by consumer

**host-fs `core` reads → generic values** (web consumers):
- `apps/file-explorer/browser`, 11 files: listings, file-tree (peek, drag, `hostFileUrl`), file-browser (drops), move-into + conflict-dialog (move), row-actions (extract), preview-pane (stat), host-path-source (stat, completions, volume).
- `apps/file-explorer/places`, 4 files: volume, drops into Favorites.
- `active-data/folder-link` (stat).
- `debug/browser-recordings` (`hostFileUrl`).
- `primitives/folder-picker` (listing).
- `primitives/file-viewer` and its `image` sub-plugin (text, open, stat, listing, image sizes, resized).
- `sonata/sources/midi/folders` uses only `MACOS_FILES_AND_FOLDERS_SETTINGS` and `user-path`, and stays.

**host-fs `server` / `machine` internals stay**, used by the computer provider and by code-explorer (`openHostFile`, `readHostPathText`, `watchHostPath/Dir`, `hostPathVersion`, `serveHostPath`, `inertHeaders`).

**`FileRef` → `FileLocation`**, about 10 construction sites:
- `conversations/…/file-pane` (file-pane, file-peek-pane, file-peek-header);
- `code-explorer/file-resolve` (web and machine);
- `apps/file-explorer/browser` (preview-pane, file-target);
- `app-data` (deleted);
- conversations' img-enhancer, screenshot-section and read-image-view (via `fileRefForPath`);
- sonata's midi file-preview.

The about 25 `source` switches in file-viewer (`file-url`, `use-file-text`, `use-file-bytes`, `machine/internal/bytes`, `use-stable-file-ref`, `file-content`, `no-preview`, media/pdf `supports`, `use-folder-images`) disappear into the generic reads.

**data-files**:
- `browse.ts` and its four reads and raw route are deleted.
- `app-data` (web plugin) is deleted.
- `documents` (root, fixture writer, binding, data dir) is deleted.
- The demo seed (`demos/workspace/bin/seed.ts` step 8, `bun-host.ts` `documents/`) writes `~/Documents/…` through `files.write` into `browser`.
- `file-explorer-in-demo.ts` e2e expects Home, not App data.
- The five other roots keep their API. Only their browser binding moves under `~/.equin/`.

**Not touched**: attachments (`AttachedFileRef`, its own blob store), transcripts, config, asset-mirror's use of its root. These are app data with their own semantics, not files a user browses. Attachments could later be a read-only `attachments` file system; not proposed now.

## Phases

Estimated at 3 sessions.

1. **The API and the viewers** (1 session).
   - Build `file-systems` core and server, with the per-tuple availability extension in `network/live`.
   - The `computer` provider wraps host-fs's machine internals. The `browser` provider absorbs data-files/memory and re-bases the roots under `~/.equin/`.
   - file-viewer moves onto `FileLocation` and the generic reads, its call sites are converted, and PDF and audio preview in the demo.
   - Exit: every viewer reads through one API, and the demo e2e (11 scripts) and the no-leak test pass.
2. **Files on the API** (1 session).
   - The browser, path bar, Places and Favorites are keyed by `FileLocation`.
   - Operations appear by capability. Routes are `/files/<fs>/at/<dir>/<open?>`, with today's `/files/at/…` redirecting to `computer`.
   - The `checkout` provider replaces the `workspace` arm.
   - app-data and documents are deleted, the demo seeds `~/Documents`, and Files opens on Home in the demo.
   - Exit: the demo and the desktop show the same Files, and the App data page is gone.
3. **Close the old spellings** (≤ 1 session).
   - Migrate folder-picker, folder-link, browser-recordings and the image sizes / resized reads.
   - Delete host-fs's `core` reads and `HostFs*` result types, and regenerate docs.
   - Exit: `rg hostFsListing` finds nothing outside host-fs internals.

## Enforcement (fix ladder)

- **Inexpressible**:
  - no viewer can branch on a file system, because the location has no `source` arm to switch on;
  - host-fs reads are deleted from `core`;
  - `browse` is removed from `defineFileRoot`.
- **Type**:
  - an op endpoint takes only a location whose system declares the capability (a branded `FileSystemId<Caps>` from the declaration);
  - a provider implements exactly its declared capabilities.
- **Boot**: one implementation per declared system per host, and no implementation of an undeclared system.
- **Test**: one conformance suite (data-files' `describeDataFilesConformance` generalised) runs against `computer` (a temp dir), `browser`, and every future provider.

## Open points for the user

- **D-a. The browser storage laid out like the desktop home** (`~/Documents` beside a hidden `~/.equin/` holding app folders). Recommended. The alternative is to keep app folders outside anything browsable in the browser, but then the desktop and the demo would differ.
- **D-b. Checkouts as their own file system with versions** (`checkout:<ws>`). Recommended. The alternative folds them into `computer` paths, but then a git-ref read has no home, and a demo tool card could not say "not available" by system.
- **D-c. Moving or copying between file systems is out of scope for now.** It is refused, not hidden.
- **D-d. Route shape `/files/<fs>/at/…`**, with old links redirected to `computer`.

## Verification (per phase)

- `./equin test plugins/infra/plugins/paths/plugins/file-systems`: the conformance suite runs against every provider.
- `./equin check`, including the new boot rule and plugin-boundaries.
- `./equin build`, then the 11 demo e2e scripts, with `file-explorer-in-demo.ts` extended so PDF and audio preview and Files opens on Home. The no-leak e2e must find no request to the page's server.
- On the desktop build: Files' move, extract, open, path bar and git columns are unchanged (screenshot.ts before/after), and conversation file peeks open checkout files at a ref.

## Session 2 outcome (2026-11-09, att-1794187380-hzxi72)

Files reads any browsable file system through file-systems; App data and the Documents root are gone.

- **Shape, as built.** The set stays closed and per-system (session 1's choice): `BrowsableFileSystem = "computer" | "browser"`; each declares `files.<fs>.list` (paged, meta `{path, parent, total, within?}`), `.peek`, `.stat` (now with the resolved `path` and `parent`), and `POST /api/files/<fs>/move`. Operations only the computer has are declared only for it (`files.computer.complete` / `.volume`, `computerFileOpen`, `computerFileExtract`, `handOffComputerFiles`), so they cannot be called on another system. `FILE_SYSTEMS[fs].capabilities` is the data the UI gates on.
- **Which systems are here**: `files.systems`, from `FileSystemProvided(fs)` contributions (host-fs machine → `computer`, the in-browser store → `browser`). Files' index opens on the first served system's Home; a link into a system not served says so.
- **Moved out of host-fs core**: the peek / complete / volume values, the open / extract / move endpoints (routes now `/api/files/computer/*`), the drag payload (now `FILE_LOCATIONS_MIME` carrying `fs`) and the archive-reason sentence. host-fs's machine half serves file-systems' declarations; `host-fs.list` and `files.computer.list` share one held listing. Still in host-fs core for session 3: `hostFsListing`, `hostFsPathStat`, `hostFileUrl`, `compareHostFsNames`.
- **The browser's home** (D22a): the memory provider keeps a home tree beside the roots; `~` lists it plus the hidden `.equin/`. Moves inside the home are the Finder's (exists / keep-both / replace / skip); the apps' folders are refused as move sources or targets. The demo seed writes `~/Documents` through `writeBrowserHomeFiles`. The browser's home is its root, so host-account's `absolutePath` / `displayPath` now take a home of `/`.
- **Routes** (D22d): `/files/computer/at/…`, `/files/browser/at/…` (a route cannot start with a `:param`, so one literal-prefix pane per system); the old `/files/at/…` pane forwards to the computer's with a history replace.
- **Places / Favorites**: a place is always a folder of a file system (`RoutePlace` is gone); Home lists one per served system; pins store `fs` (an old pin heals to `computer`, and keeps its row key, so saved order survives).
- **Cross-system move** (D22c): a drop of another system's files says "Moving files between two file systems is not supported yet".
- **Not in this session**: Files never had rename / new folder / trash; they are not added (the capability flags have no such entries yet). Checkouts are not browsable in Files (read file by file).
- **Verified**: build + every check; unit tests of host-fs, file-systems, data-files/memory, Files, host-account; all 11 demo e2e scripts (`file-explorer-in-demo.ts` now opens on Home, `~/Documents`, every viewer, and `~/.equin/apps/prototypes`); desktop Files by hand and by its e2e scripts (listing, Places, storage meter, folder sizes, zips, git dots / Diff, the old-URL redirect, move on disk). Pre-existing failures, identical on main: `explorer-verify` / `folders-on-top-verify` / `item-count-verify` (their cell selectors), git-verify's file badge in a deep folder; select-and-move's 5 s wait for a pushed listing times out on this loaded machine on main too (FSEvents dropping events).
