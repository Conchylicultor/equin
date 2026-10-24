# Browse archives as folders in the file explorer

## Context

The file explorer (`apps/file-explorer/browser`) only expands real directories.
Users want to open a `.zip` in the tree like a folder: expand it, walk its
sub-folders, preview a file inside it. The user asked for a **general archive
interface**: zip ships first, and tar / 7z / … plug in later as one plugin each.
Out of scope: `.dmg` (needs mounting, not reading), nested archives (a zip inside a zip), and writing into archives.

The explorer, its routes (`/files/at/<path>`), the path bar, the listings cache and
the file viewer (`FileRef { source: "host", path }` → `hostFsText` /
`hostFileUrl`) all key on **a path string**. So the design gives host-fs
**virtual paths that cross into an archive**:
`~/Downloads/Edition 2022.zip/photos/img1.jpg`. Once `infra/host-fs` resolves
such a path, almost everything downstream works without changes.

## Design

### 1. Contract (`infra/host-fs/core/internal/endpoints.ts`)

- `HostFsEntry` gains `archive?: { format: string }`. It is present on a
  **real file** whose name a registered format claims. The `kind` stays `"file"`,
  so the size, icon and Open with default app are unchanged, and consumers that
  ask for folders (`folder-picker`, `complete`) keep refusing it. That is the
  intended behaviour: you cannot pick a folder inside a zip as a cwd.
- An entry *inside* an archive is an ordinary `dir` / `file` entry. Archive
  members that are symlinks or devices become `other`. Archives inside an archive
  get no `archive` flag (no nested archives in v1).
- The `ok` arms of `list` and `stat` gain `within?: { archive: string; format: string }`.
  It is set when the path lies inside an archive, so the UI knows a path is
  virtual without parsing the path itself.
- A new failure arm, shared by `list` / `stat` / `text`:
  `{ kind: "unreadable-archive", path, reason: "corrupt" | "encrypted" | "unsupported-method" | "too-many-entries" }`.
  `raw` maps it to a status code (422 + message).
- One exported predicate, `isBrowsable(entry) = entry.kind === "dir" || entry.archive !== undefined`.
  Every UI site that decides whether something expands calls this predicate,
  never its own check.

### 2. Format registry (`infra/host-fs/server`)

`defineArchiveFormat(format) → ArchiveFormat & Registration`. This is the same
module-eval registry shape as `defineTrashSource`
(`plugins/infra/plugins/trash/server/internal/registry.ts`): duplicate ids
throw, and host-fs never names a format.

```ts
interface ArchiveFormat {
  id: string;                         // "zip"
  claims(name: string): boolean;     // by extension: .zip (later .tar.gz, .7z…)
  index(file: string, signal): Promise<ArchiveIndexResult>; // ok {members} | unreadable {reason}
  open(file: string, member: ArchiveMember): Promise<MemberRead>; // stream + size, or unreadable
  slice?(file, member, range): …;    // optional: a true byte range (stored entries)
}
interface ArchiveMember { path: string; kind: "dir" | "file" | "other"; size: number; mtimeMs: number; }
```

### 3. Resolution and indexing (`host-fs/server/internal/archive/`)

- **`locateHostPath(abs)`** returns `{ kind: "disk", path }` or
  `{ kind: "archive", file, format, inner }`. The fast path is one `lstat`: if
  the path exists on disk it is a disk path, which keeps today's behaviour exact,
  including a real directory named `foo.zip`. On `ENOTDIR` or `ENOENT`, it walks
  up the ancestors until it finds a regular file that some format claims. If none
  is found, the original error stands (`missing`).
- **Index cache.** Each format's member list is normalised into a
  `Map<dirPath, HostFsEntry[]>`:
  - Implicit parent directories are synthesised.
  - Names that escape the root (`..`, absolute paths, `\`) are dropped.
  - A duplicate name keeps its last occurrence.
  - Children are sorted by the same `byName` rule as `list`.

  The cache is an in-memory LRU keyed by `(path, ino, mtimeMs, size)`, bounded
  by archive count and total member count. When a file changes on disk, its key
  changes and the next read re-indexes it, so the cache can never serve stale
  data. Index builds are single-flighted (`packages/inflight`) and run under
  `withHeavyReadSlot` (`infra/host/host-read-pool`), so a 2 GB zip cannot starve
  the box.
- **Endpoints branch once**, on the result of `locate`:
  - `list` and `stat` read from the index.
  - `text` checks `member.size` against `HOST_FS_TEXT_MAX_BYTES` *before*
    decompressing, then runs the result through the existing `decodeTextBytes`.
  - `raw` streams the member with the same `inertHeaders`, using a
    `Content-Type` derived from the member's name and the known
    `Content-Length`. A `Range` request is honoured only through `slice`
    (stored entries). Otherwise it is ignored and the response is a 200, which
    RFC 9110 allows.
  - `open`: `reveal` reveals the archive file itself. Open with default app on a
    member returns a new typed arm, `in-archive` (extracting to a temp file is a
    follow-up). `useOpenHostFile` and the preview pane hide the action when
    `within` is set.
  - `complete` and `volume` stay disk-only.
  - `listHostDir` also sets `archive` on any child a registered format claims.
    This is a name check only, so listings get no slower.

### 4. Zip format: new plugin `infra/host-fs/plugins/zip` (server only)

A native TS central-directory reader with no npm dependency (about 250 lines):

- **Finding the central directory.** Scan the last 64 KiB + 22 bytes for the end
  record (EOCD), following the zip64 EOCD locator and record when present, then
  read the central directory with positioned `FileHandle.read`.
- **Decoding names.** Use UTF-8 when general-purpose flag bit 11 is set, or when
  the name decodes as valid UTF-8 under a fatal decoder. macOS Archive Utility
  writes UTF-8 without setting the flag. Otherwise decode as CP437. The Info-ZIP
  Unicode-path extra field (0x7075) wins when present.
- **Member metadata.** Directories are names ending in `/` (or the external
  attribute bits). `mtime` comes from the DOS date/time, overridden by the
  extended-timestamp extra field (0x5455) when present. Unix-mode symlinks become
  `other`.
- **Reading a member.** Skip the local header (its own name and extra
  lengths). Method 0 (stored) is a `Bun.file(...).slice` and also provides
  `slice`. Method 8 (deflate) is piped through `zlib.createInflateRaw()`.
  Encrypted entries (flag bit 0) are `encrypted`; any other method is
  `unsupported-method`. The CRC is checked on full reads (`text`).
- The format registers itself with `register: [zipFormat]` and claims `.zip`
  (case-insensitive). A later `tar` plugin registers the same way. libarchive's
  `bsdtar` is on macOS, but it has no machine-readable listing, so each format
  stays native or uses a library.

### 5. Explorer (`apps/file-explorer/browser`)

- `file-tree.tsx`:
  - `hasChildren` and `openOnActivate` (lines 220 and 270) and the
    directory-first sort (line 64) use `isBrowsable`.
  - Line 104's walk recurses into browsable rows. The Size column keeps showing
    the archive's size, since it is still a file.
  - The icon gets a small "archive folder" treatment: `FileTypeIcon` with
    `isDir` plus an archive badge, or the Seti zip glyph while it is closed.
- `file-browser.tsx` `onActivate` / `onOpen` (lines 305–308): a browsable row
  expands or navigates like a directory. Rooting the explorer *into* a zip
  (`/files/at/~/Downloads/x.zip`) just works, because the route is the path.
- `host-path-source.ts:129`: a stat that is browsable maps to `"dir"`, so typing
  a zip path in the path bar opens it as a folder.
- `EntryRow` (`core/internal/entry-row.ts`) carries `archive` through to the
  rows.
- The git lens: paths inside an archive never match git status, so it needs no
  change.
- `folder-picker`: no change. It filters on `kind === "dir"`, which is correct.

## Critical files

- `plugins/infra/plugins/host-fs/core/internal/endpoints.ts`: schemas, `isBrowsable`.
- `plugins/infra/plugins/host-fs/server/internal/{list,stat,text,raw,open}.ts`: the one `locate` branch in each.
- `plugins/infra/plugins/host-fs/server/internal/archive/{registry,locate,index-cache}.ts`: new.
- `plugins/infra/plugins/host-fs/plugins/zip/server/{index.ts,internal/*.ts}`: new plugin.
- `plugins/apps/plugins/file-explorer/plugins/browser/web/components/{file-tree,file-browser}.tsx`, `web/internal/host-path-source.ts`, `core/internal/entry-row.ts`.
- `plugins/primitives/plugins/file-viewer/web/components/no-preview.tsx`: hide Open for in-archive files.
- `plugins/infra/plugins/host-fs/CLAUDE.md`: document virtual paths, the registry and the new arms.

## Verification

- **Unit tests** (`./equin test plugins/infra/plugins/host-fs`):
  - Test fixtures are zips built in the test with `zip` / `ditto -c -k` into a
    temp dir: stored and deflated entries, implicit dirs, a UTF-8 name without
    the flag (ditto), a CP437 name, an encrypted entry (`zip -e -P`), zip64
    (`zip -fz`), a `../evil` name, a truncated file (`corrupt`), and a real
    directory named `x.zip`.
  - Assert `list`, `stat`, `text` and `raw` (including `Range` on a stored entry
    and a 200 for a deflated one) and the cache invalidating after the file is
    rewritten.
- **E2E:** extend `plugins/apps/plugins/file-explorer/e2e/explorer-verify.ts`:
  put a fixture zip in a temp folder, open it in the tree, expand a sub-folder,
  click a text file and see its preview, then navigate to the zip's route via
  the path bar.
- **Manual:** `./equin build`, then open
  `~/Downloads/Edition 2022 (23-24 juillet)-…zip` in the deployed explorer.
