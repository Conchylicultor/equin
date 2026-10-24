# File explorer: Items field (folder item counts without expanding)

## Context

In the `/files` tree DataView, a folder's item count appears only in the Size
cell, and only after the folder has been expanded and listed
(`childCount(listings, path, shows)` in
`plugins/apps/plugins/file-explorer/plugins/browser/web/components/file-tree.tsx`).
Until then the cell shows "—", so you cannot scan or sort folders by how many
items they hold.

Wanted: an **Items** field, hidden by default like Created and Accessed, that
shows every visible folder's count without expanding it and can be sorted.
Constraints:

1. The cost is paid **only while the field is in use**. With Items hidden, a
   listing makes no extra directory read per subfolder.
2. The count follows the browser's visibility rules (Show hidden files and the
   lens hide rules) exactly as the Size column's count does.
3. Folders inside archives, archive files, and unreadable or denied folders
   each have a defined state, never a misleading 0.

Follows `research/2026-10-07-apps-file-explorer-fields.md`.

## Key decisions

- **"In use" is a generic DataView signal, not a file-explorer hack.** Today a
  field cannot tell whether the active view shows it, so a field whose values
  need their own read pays that read always. Add
  `FieldExtensionProps.isInUse(field)` to the data-view primitive. It returns
  true when the active view instance shows the field in its body, sorts by it,
  filters on it, or groups by it. Other costly contributed fields (custom
  columns, Sonata's play count, git) can then gate their reads the same way.
  Sorting or filtering by Items while its column is hidden still needs every
  value, so those cases count as "in use" too.
- **Counting is a names-only read on the server.** Lens hide rules are
  client-side predicates on the absolute path (git's ignore index), so the
  server cannot return a count that respects them. A new host-fs endpoint
  returns each requested folder's child **names and hidden flag**. That is one
  `readdir` per folder, with no per-child `lstat`. The browser applies the
  same `shows(entry, path)` it applies to listings, so the count matches the
  Size column's count by construction.
- **States, not zeros:**

  | Row | Items cell | Sort value |
  |---|---|---|
  | file, symlink, other | empty | null |
  | folder already listed (expanded) | `childCount` from its listing (same as Size) | n |
  | folder on disk | count of visible children | n |
  | folder **inside** an archive | counted from the cached archive index (the parent listing just loaded it, so this is cheap) | n |
  | **archive file** on disk (a `.zip` row) | "—", tooltip "Expand the archive to count its items" (opening every zip's central directory is not a cheap read); its listing count once expanded | null |
  | denied | muted "No access", tooltip "Permission denied" | null |
  | vanished, missing, not-a-dir | "—" | null |
  | unreadable archive | muted "Unreadable", tooltip with the archive reason | null |
  | more than 10,000 entries | "10,000+", tooltip "Counted without visibility rules" (the names are not shipped) | raw total |
  | loading | `Loading` shimmer | null |
  | request failed | the field's `readError` (the DataView renders Retry) | — |

  A null value sorts last.

## 1. data-view: `isInUse` on field extensions

- `plugins/primitives/plugins/data-view/core/internal/types.ts`: add to
  `FieldExtensionProps<TRow>`:
  ```ts
  /** Whether the active view shows, sorts, filters or groups by `field` — a
   *  contributor whose values need a read of their own gates that read on it. */
  isInUse: (field: Pick<FieldDef<TRow>, "id" | "visible">) => boolean;
  ```
- New pure helper `core/internal/field-in-use.ts` (+ test): `fieldInUse(state,
  field)` over `{ visibleFields, sort, filter, groupBy }`.
  - **Body visibility:** the explicit `visibleFields` includes the id; with no
    explicit list, `field.visible !== false`. This is the same rule as
    `resolveBodyFields`.
  - **Other uses:** a sort rule, a group-by rule, or any leaf in the filter
    tree names the field.
- `web/components/data-view-body.tsx`, `CollectBodyFields`: read the active
  instance's view state, which `useDataViewModel` already exposes per view id
  (`visibleFields`, `sort`, `filter`, `groupBy`). Build `isInUse`, memoized on
  that state, and thread it through `CollectFieldExtensions`'s surface
  coordinates (`web/internal/field-extensions.tsx`) to every contributor. The
  merged-data-view path gets the same treatment.
- Document it in the data-view `CLAUDE.md` field-extensions section.

## 2. host-fs: a `peek` read

`plugins/infra/plugins/host-fs/core/internal/endpoints.ts`:

```ts
export const HOST_FS_PEEK_MAX_PATHS = 500;
export const HOST_FS_PEEK_MAX_NAMES = 10_000;

const PeekResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), path: z.string(),
    children: z.array(z.object({ name: z.string(), hidden: z.boolean() })) }),
  z.object({ kind: z.literal("too-many"), path: z.string(), total: z.number() }),
  /** An archive file on disk: peek never opens one. */
  z.object({ kind: z.literal("archive"), path: z.string() }),
  Missing, Denied, NotADir, UnreadableArchive,
]);

/** The child names of several folders, with no per-child stat: one readdir each. */
export const hostFsPeek = defineEndpoint({
  route: "POST /api/host-fs/peek",
  body: z.object({ paths: z.array(z.string()).max(HOST_FS_PEEK_MAX_PATHS) }),
  response: z.object({ results: z.array(PeekResult) }), // aligned with `paths`
});
```

New `server/internal/peek.ts`:

- Resolve each path with `resolveHostPath`, then call `locateHostDir`.
  - **Archive location, `inner === ""`, path is the archive file:** return
    `archive`.
  - **Archive location, inside the archive:** use `listArchiveDir`, which reads
    the cached `archiveTree`, and map its entries to `{name, hidden}`.
  - **Disk:** call `readdir(path)` only. Name-based `hidden` comes from
    `isHiddenName`, so a symlinked folder's contents are read through the
    link. Classify errors with `classifyFsError`.
- Run at most 8 folders concurrently per request. Register the route in
  `server/index.ts`.

The listing endpoint is unchanged, so a normal listing costs exactly what it
costs today.

## 3. Browser: the Items field

All in `plugins/apps/plugins/file-explorer/plugins/browser`:

- **`EntryFilter`** narrows to `(entry: Pick<HostFsEntry, "hidden">, path) =>
  boolean`. That is all `shows` reads (see `file-browser.tsx`), and it lets
  peeked children go through the same predicate.
- **`web/internal/tree-context.ts`** (new): `FileTreeContext` holds `{ listings,
  shows, folders }`. Here `folders` is every row of `buildRows` with `kind ===
  "dir"`, grouped by its parent directory. `FileTree` provides it around the
  `DataView`.
- **`web/internal/folder-peeks.ts`** (new): `useFolderPeeks(folders, enabled)`.
  - Calls `useQueries` with one query per **parent directory**, chunked to
    `HOST_FS_PEEK_MAX_PATHS`.
  - The query key is the parent plus its sorted child paths, so expanding a
    folder adds a query and never refetches the others. Each query has
    `enabled`.
  - It goes through the same query cache as listings, so revisiting re-reads
    it like a listing.
  - It returns `Map<path, PeekState>`.
- **`core/internal/item-count.ts`** (new, + test): a pure `itemCount(listing |
  undefined, peek | undefined, shows, path)` returning a discriminated
  `ItemCount` (`count | archive | denied | unreadable | gone | many | loading`).
  It prefers the folder's own listing, so an expanded folder reads exactly as
  Size does.
- **`web/internal/items-field.tsx`** (new): a field-extension component
  contributed by the browser to its own `FileBrowserSlots.Fields` (`section:
  null`, registered in `web/index.ts`).
  - The field is `{ id: "items", label: "Items", type: "number", width:
    "72px", align: "end", visible: false }`.
  - `enabled = isInUse(field)`. While it is not in use, `value` is null and the
    cell is empty, and no peek is issued.
  - `readError` is set from a failed peek query.

  Why a contribution and not a base field: only a field extension is a mounted
  component that receives `isInUse` and may hold the query hooks.
- The Size column is unchanged.

## Files

- `plugins/primitives/plugins/data-view/core/internal/{types.ts,field-in-use.ts(+test)}`, `core/index.ts`
- `plugins/primitives/plugins/data-view/web/components/data-view-body.tsx`, `web/internal/field-extensions.tsx`, merged path, `CLAUDE.md`
- `plugins/infra/plugins/host-fs/core/internal/endpoints.ts`, `core/index.ts`
- `plugins/infra/plugins/host-fs/server/internal/peek.ts` (new), `server/index.ts`, `server/internal/host-fs.test.ts`
- `plugins/apps/plugins/file-explorer/plugins/browser/core/internal/item-count.ts(+test)`, `core/index.ts`
- `plugins/apps/plugins/file-explorer/plugins/browser/web/components/file-tree.tsx` (`EntryFilter`, context provider)
- `plugins/apps/plugins/file-explorer/plugins/browser/web/internal/{tree-context.ts,folder-peeks.ts,items-field.tsx}`, `web/index.ts`
- `plugins/apps/plugins/file-explorer/e2e/item-count-verify.ts` (new)

## Verification

1. Run `./equin test plugins/primitives/plugins/data-view
   plugins/infra/plugins/host-fs plugins/apps/plugins/file-explorer`.
   - `fieldInUse` cases: hidden by default; explicitly shown; sorted while
     hidden; a filter leaf; group-by.
   - `peek` cases: a plain dir with a dotfile; a `chmod 000` dir giving
     `denied`; a zip file giving `archive`; a folder inside a zip giving
     `ok`; a missing path; a file giving `not-a-dir`.
   - `itemCount` cases: listing-preferred; hidden and lens filtering; each
     state.
2. Run `./equin build` in the background.
3. Run a new e2e script `item-count-verify.ts` on `/files` (home):
   - Record requests: **no `/api/host-fs/peek` while Items is hidden**.
   - Switch Items on from View options. Folder rows then show counts, and an
     expanded folder's Items equals its Size count.
   - Toggle Show hidden files and check a folder's count changes.
   - Sort by Items.
   - Browse into a `.zip`: its subfolders are counted, and a `.zip` row shows
     "—".
4. Take a screenshot with `screenshot.ts --path /files --click "View options"`
   for a visual check of the cell states.
