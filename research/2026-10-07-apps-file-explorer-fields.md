# File explorer: more DataView fields

## Context

The file explorer's tree DataView (`/files`) has only Name, Modified, and Size,
plus the git plugin's contributed Git badge and "Changed vs main". There is no
way to sort, group, or filter by what a file *is*: the user noticed that file
type is missing. Finder-class fields we want:

| Field | Shown by default | Source |
|---|---|---|
| **Kind** | yes (hidden ≤ 900px) | `fileTypeOf(name).label`, "Folder" for a directory |
| **Category** | no | `fileTypeOf(name).preview` coarsened + folder/other (enum) |
| **Extension** | no | last extension of the name |
| **Path** | no | `row.path` |
| **Link target** | no | `HostFsEntry.symlinkTarget` (already on the wire) |
| **Created** | no | **new** `HostFsEntry.birthtimeMs` |
| **Accessed** | no | **new** `HostFsEntry.atimeMs`, labelled "Accessed", not "Last opened" (decided: atime is cheap but approximate; it is not Finder's Spotlight-backed "Date Last Opened") |

All fields get Sort, Filter, and the Fields toggle for free because each one
has a `value`. Fields that are hidden by default are still in the options
popover.

## 1. host-fs: two optional timestamps

`plugins/infra/plugins/host-fs/core/internal/endpoints.ts`, `HostFsEntrySchema`:

```ts
/** When the entry was created, where the filesystem records it. Absent inside an archive, and on a filesystem without birth time. */
birthtimeMs: z.number().optional(),
/** Last access as the filesystem records it — approximate (relatime/lazy updates, and our own reads bump it). Absent inside an archive. */
atimeMs: z.number().optional(),
```

Optional, not `number | 0`: "not recorded" must not read as 1970 (the
no-absorbed-failure rule).

`plugins/infra/plugins/host-fs/server/internal/entry.ts`, `describeEntry`:
add the two fields in all three arms, taken from the same `Stats` that already
supplies `mtimeMs` (`own` for a plain entry or an unresolvable link, the
target's `st` for a followed link). This adds no I/O. Write one helper:

```ts
function times(st: Stats): Pick<HostFsEntry, "birthtimeMs" | "atimeMs"> {
  // Linux filesystems without statx birth time report 0: not recorded, not 1970.
  return { atimeMs: st.atimeMs, ...(st.birthtimeMs > 0 ? { birthtimeMs: st.birthtimeMs } : {}) };
}
```

Archive members (`server/internal/archive/tree.ts`, `ArchiveMember`) are
unchanged. A zip's central directory carries only mtime, so its rows leave
both fields absent.

Other `HostFsEntry` consumers (folder-picker, file-viewer stat, places) stay
unaffected because the fields are additive and optional.

## 2. Browser: the row and the derivations

`plugins/apps/plugins/file-explorer/plugins/browser/core/internal/entry-row.ts`,
`EntryRow`: add `birthtimeMs?: number`, `atimeMs?: number`, and
`symlinkTarget?: string`. Field contributors such as git then see them too.

New `browser/core/internal/entry-kind.ts` (pure, exported from `core/index.ts`,
with `entry-kind.test.ts` next to it):

- `entryKindLabel(row)`: "Folder" for a `dir`, "Link" for an unresolvable
  `symlink`, "Other" for `other`, otherwise `fileTypeOf(row.name).label`
  (from `@plugins/primitives/plugins/file-type/core`; it already returns
  `"<EXT> file"` or `"File"` for unknown types). An archive's row stays a file
  ("ZIP archive").
- `entryCategory(row)`: a `"folder" | "image" | "video" | "audio" | "pdf" |
  "document" | "code" | "other"` enum. `markdown`, `text`, and `csv` previews
  fold into `document`, and no preview means `other`. Also export
  `ENTRY_CATEGORY_OPTIONS: FieldOption[]` with labels ("Folders", "Images", …)
  for the enum field. `FieldOption` is a data-view `core` type, which browser
  core may import.
- `entryExtension(name)`: the lowercase last extension without the dot, or
  `null` for none or a dotfile with no further dot (`.gitignore` → `null`,
  `a.tar.gz` → `gz`).

`buildRows` in `web/components/file-tree.tsx` copies the three new entry
properties onto the row, only when they are present.

## 3. Browser: the fields

In `file-tree.tsx`, generalise `modifiedField(now)` into
`timeField(id, label, get: (r) => number | undefined, now, visible?)`, with the
same cell (short date plus the full date on hover, `"—"` when absent, `value`
`null` when absent so it sorts last). Then Modified, Created, and Accessed are
three calls.

Field list, in this order:

```
name · kind (narrow ? hidden : 140px) · modified · size ·
created (visible:false) · accessed (visible:false) ·
category (enum, ENTRY_CATEGORY_OPTIONS, visible:false) ·
extension (visible:false) · path (visible:false) · link (visible:false, value: symlinkTarget ?? null)
```

These fields describe the file itself and live in the browser's own schema.
They are not `FileBrowserSlots.Fields` contributions, because that slot is for
add-ons such as git.

Check during implementation:
- Whether the `ExplorerDir` preview pane (`web/components/preview-pane.tsx`)
  shows a metadata block. If it does, add Kind and Created there.
- If the narrow (≤ 900px) layout gets crowded, drop Kind the same way Modified
  is dropped (`useViewportAtMost(900)`).

## Files

- `plugins/infra/plugins/host-fs/core/internal/endpoints.ts`: schema.
- `plugins/infra/plugins/host-fs/server/internal/entry.ts`: populate.
- `plugins/apps/plugins/file-explorer/plugins/browser/core/internal/entry-row.ts`: row.
- `plugins/apps/plugins/file-explorer/plugins/browser/core/internal/entry-kind.ts` (+ test): derivations.
- `plugins/apps/plugins/file-explorer/plugins/browser/core/index.ts`: exports.
- `plugins/apps/plugins/file-explorer/plugins/browser/web/components/file-tree.tsx`: `buildRows` and the fields.
- Plugin `CLAUDE.md` autogen blocks and `docs/plugins-*.md` are regenerated by the build.

## Verification

1. `./equin test plugins/apps/plugins/file-explorer plugins/infra/plugins/host-fs`
   runs the new `entry-kind.test.ts` (kind labels, category folding, and
   extension edge cases) and the existing host-fs and archive tests. Extend a
   host-fs entry test to assert `birthtimeMs > 0` and that `atimeMs` is present
   for a temp file, and that both are absent for a zip member.
2. `./equin build` (in the background), then
   `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path "/files/at/~%2FDownloads" --out /tmp/files`
   should show the Kind column with "PDF document" and the other types.
3. With `--click "View options"`, the Fields list should show Created,
   Accessed, Category, Extension, Path, and Link target. In the live app,
   group by Category, sort by Created, and filter Extension = pdf.
4. Browse into a `.zip`: Created and Accessed show "—", and Kind and Category
   still work.
