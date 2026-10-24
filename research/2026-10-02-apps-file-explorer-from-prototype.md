# File explorer app from proto-1790864772-0r54, replacing the code-explorer Explorer

## Context

Two half-surfaces browse files today, and neither matches the design:

- `apps/file-explorer` is an empty shell: `/files`, `FileExplorer.Sidebar`/`Toolbar` slots, a Miller host, no panes, no contributors.
- `code-explorer` is the real browser. It has the agent-manager sidebar entry "Explorer" (`code/:worktree`) and the conversation action-bar button (`convFileTreePane`).
  - It lists a worktree with `git ls-files`, flat and whole-tree, into a `DataView` tree.
  - Files open in the conversation `file-pane`, which has a tiered renderer slot `FilePane.Renderer` (raw / markdown / image / diff).

The prototype (`route:/files`, user on defaults calm / sidebar-tonal / neutral) settles the target:

- a Places sidebar with a storage meter;
- a Dolphin path bar (breadcrumb ⇄ editable field, ⌘L, folder autocomplete);
- a tree with Modified / Size columns, inline expand, double-click to re-root, and a filter;
- a side preview pane for md, code, csv, image, pdf, and a fallback with "Open with default app";
- Seti glyphs and compact density.

Outcome: one file browser, the `/files` app, built from general-purpose primitives. The conversation Explorer button and the agent-manager "Explorer" entry become entry points into it, so the code-explorer panes go away without losing worktree browsing or diff vs `main`.

### Decisions (user-validated)

- **Reach: the whole host.** Any path the user account can read. Worktrees are places, not a separate mode.
- **Variants: ship the defaults only** (calm, sidebar-tonal, neutral). Feel, structure and colour stay prototype explorations.
- **Icons: real Seti glyphs through the existing icon pipeline.** Vendor the MIT Seti SVGs as a third icon set, and add one extension/filename → `{icon, colour token, label}` table.

## Security model

Per `research/2026-07-02-global-adr-single-instance-per-user.md`, the instance has one trusted principal, there is no auth on localhost, and filesystem permissions are the boundary. So:

- **No path sandbox.** The server reads what the user account can read, the same as `folder-picker/browse` and code-explorer's absolute-path `file`/`image` reads today. EACCES/EPERM is a typed `denied` state the UI renders (e.g. `~/.Trash` without Full Disk Access). It is never an empty folder.
- **Read-only in v1.** No rename, move or delete.
  - The one side effect is **Open with default app**: `POST`, spawning macOS `open <path>` through `infra/spawn` (`spawnCaptured`), with the path passed as an argv element (never a shell).
  - "Reveal in Finder" (`open -R`) shares that endpoint.
- **Browser-origin threats are the real exposure, not the user.** A web page in the user's browser must not be able to read `~/.ssh` through `localhost:9000`.
  - The cross-origin fetch read is blocked by CORS. A `POST` to open must also check `Origin` against `*.localhost:9000`.
  - The raw-bytes endpoint serves `Content-Disposition: inline` with `X-Content-Type-Options: nosniff` and a `Content-Security-Policy: sandbox`, so an HTML or SVG file opened in the preview cannot run script on our origin.
  - **To verify during implementation:** the gateway rejects a non-`*.localhost` `Host` (DNS-rebinding). If it does not, file that as its own task. It is a pre-existing hole that code-explorer and folder-picker already have, and this work does not widen it.
- **Hidden by default, not denied.** Dotfiles are hidden behind a "Show hidden" toggle. Inside a git checkout, ignored entries are hidden behind "Show ignored". This is presentation only.

## Plugin breakdown

New primitives are general-purpose. App-specific plugins live under `apps/file-explorer/plugins/*`.

### 1. `infra/host-fs` (new, server + core): the one host-filesystem API

- **Endpoints** (`defineEndpoint` in core, `implement()` in server):
  - `list?path` → `{ path, parent, entries: [{ name, kind: dir|file|symlink, size, mtimeMs, hidden, symlinkTarget? }] }`, or a discriminated `{ kind: "missing" | "denied" | "not-a-dir" }`.
    - Uses `readdir(withFileTypes)` plus `lstat`/`stat`. A symlink to a dir counts as a dir, which fixes the folder-picker bug.
  - `stat?path`: for path-bar validation (file → navigate to its parent and open the file).
  - `complete?prefix`: folder-only children of `dirname(prefix)` matching `basename(prefix)`, case-insensitive, capped (path-bar autocomplete). Expands `~`.
  - `text?path`: capped at 2 MiB, binary-sniffed (NUL in the first 8 KB). Reuse the logic now in `code-explorer/server/internal/get-file-content.ts`, moved here.
  - `raw?path`: streamed bytes, `Content-Type` from the extension, `Range` support (PDF/video). Plus `hostFileUrl(path)` in core.
  - `volume?path`: `statfs` → `{ name, total, free }` (storage meter, status bar "190 GB available").
  - `POST open {path, reveal?}`: Open with default app / Reveal.
  - `search?root&q` (phase 2): bounded name-only recursive walk (depth and result caps, skips ignored and hidden), NDJSON-streamed via `infra/ndjson-stream`. It backs the tree filter beyond loaded nodes.
- **Freshness, no polling** (phase 3): an on-demand live value per *expanded* directory, fed by `infra/file-watcher` (`defineFileWatcher`, `notify()`), bounded by the set of directories open in a mounted explorer.
- **Migrations onto it:**
  - `primitives/folder-picker` swaps its `browse` endpoint for `host-fs list` (dirs filtered client-side).
  - code-explorer's unguarded absolute / `~` reads in `file` and `image` are removed. Their callers that pass absolute paths (jsonl `read-image-view`, `img-enhancer`) use `hostFileUrl`.

### 2. `primitives/file-type` (new, core + web): what a file *is*

- **Table**, plain data in core: extension and special filename (`package.json`, `Dockerfile`, `.gitignore`, `CLAUDE.md`, …) → `{ icon: seti("…"), tone, label, preview kind hint }`. Unknown types fall back to a generic glyph and "<EXT> file".
- **`tone`** is a closed set of file-type colour tokens (`--file-blue`, `--file-yellow`, `--file-green`, `--file-red`, `--file-purple`, `--file-pink`, `--file-orange`, …), defined in a `ui/tokens` group with light and dark values. So themes adapt them, and there is no hard-coded hex.
- **Web:** `<FileTypeIcon name isDir open?/>`.
  - Folders stay the Material `folder` / `folder_open` symbol in `--folder` (blue).
  - Files draw their Seti glyph.
- **Reuse:** conversation file panes, attachments and the pages `file-block`'s `iconForMime` can adopt it (follow-up).

### 3. `ui/icons` gains a Seti set

- **Vendoring:** vendor the Seti SVGs (MIT, seti-ui / VS Code `theme-seti`) as an Iconify-format JSON. The license must be checked, and the vendoring script pinned to a commit.
- **Constructor:** `seti("typescript")` joins `symbol` and `brand`, with literal names, a name type generated like `symbol-names.generated.ts`, and manifest-scanned like the others.
- **What ships is decided by the table, not by the host's files.**
  - The build never sees the user's disk. The manifest scan finds the `seti("…")` literals in the `file-type` table, so every glyph the table can return ships, and nothing else.
  - The host's files only *select* among them at runtime (extension → table row → glyph). An extension with no row gets the generic file glyph.
  - The set is bounded by the table: on the order of the ~150 types Seti covers, small single-path SVGs.
- **Not resident.** The Seti sheet is not part of the boot snapshot. The sprites plugin already serves non-default sheets on demand (`GET /api/icons/sprite/:hash/:key`). The Seti sheet is one of those, fetched the first time a `<FileTypeIcon>` mounts, so apps that never show files pay nothing.
- **Style:** Seti has one style. It ignores the theme's icon shape and fill axes, as `brand` already does.

### 4. Data-view / tree extensions (generic)

The explorer is a `DataView` (rule: collections of domain records). The tree view is extended for what it lacks, rather than hand-rolled.

- **Lazy children.**
  - `HierarchyConfig.hasChildren?(row)`: shows the chevron with no loaded children.
  - An `onExpandedChange` callback: the consumer fetches on first expand.
  - A per-node `loading` / `failed` child placeholder row rendered by `TreeList`.
- **Aligned columns.** `viewOptions.tree.columns: "aligned"` turns visible secondary fields into fixed-width right-aligned cells (field `width`), plus a sticky header row (Name / Modified / Size) with sort. Today they render as trailing chips. `RowChrome`'s `trailing` hosts the cells.
- **Open gesture.** `onRowOpen` (double-click / Enter), distinct from `onRowActivate` (single click). It lives in `useTreeRow` and also suits the table view.
- **Search.**
  - Subtree-preserving search already exists (`searchAccessor`).
  - The explorer adds a "search deeper" server walk (`host-fs search`) whose hits are merged in as rows.
- **Already there:** keyboard ↑ ↓ ← → and compact density. Gaps are checked against the prototype keys: Enter opens, Backspace goes up, Esc closes the preview.

### 5. `primitives/path-bar` (new, web): Dolphin-style editable breadcrumb

- **Crumbs:** composes `primitives/breadcrumb` for crumb mode, which already handles overflow folding and the separator region.
- **Editing:**
  - Click on empty space or the pencil switches to a mono `Input`.
  - `⌘L` is a `defineShortcut` scoped to the surface.
  - An autocomplete popover handles ↑ ↓, Tab completion, Enter commits, and Esc / blur reverts. Invalid input shows a `bad` state.
- **Generic over a source:** `{ segments(path), complete(prefix) → Promise<string[]>, validate(path) → dir | file | invalid }`. No host-fs import, so a future git-ref or page-tree path bar can reuse it.
- **Combobox:** none exists in ui-kit. It is built inline here and extracted to a primitive if a second consumer appears.

### 6. `primitives/file-viewer` (new, lifted from conversation `file-pane`): the per-type viewer registry

- **The slot moves.** The tiered `FilePane.Renderer` slot (native / contextual / fallback, with tabs) becomes domain-neutral and moves here, out of `conversations/…/code/file-pane`.
- **Target:**
  ```ts
  type FileRef =
    | { source: "host"; path: string }
    | { source: "git"; worktree: string; ref?: string; path: string };
  ```
  plus optional `{ gitStatus }` context.
  - Reading is `useFileText(ref)` / `fileUrl(ref)`, dispatching to `host-fs` or `code-api`.
  - Renderers never know the source.
- **Viewer sub-plugins** (each one folder, with `supports(target)`):
  - `markdown`: `primitives/markdown`. Moved from file-pane/markdown.
  - `code`: shiki with line numbers. Extract the line-numbered listing now duplicated in file-pane `raw-view` and jsonl `code-listing` into `primitives/syntax-highlight` as `<CodeListing>`, used by both.
  - `csv`: a small RFC-4180 parser in core, rendered by `primitives/data-table` (sorting and virtualization for free). Capped rows with a "showing first N".
  - `image`: an inline `<img>` that opens `overlay/image-viewer` on click.
  - `pdf`: `<iframe src={fileUrl}>` (the browser's native viewer, no new dependency). Host only, since git refs have no raw route for PDF yet.
  - `diff`: `contextual` when `gitStatus` ≠ clean. Uses `primitives/diff-view` `DiffOrImageView`. Moved from file-pane/diff.
  - `fallback`: big type icon, "No preview for <label> files", and **Open with default app** (host only).
- **Pane header** per the prototype: icon, name, `parent · size · modified`, and Open / … / Close.
- **Migration:** conversation `file-pane` becomes a thin consumer (the `filePeekPane` route and `FilePaneView` keep their props and pass a `git` FileRef). So file peeks from chat, review and commits all gain the new viewers.

### 7. `apps/file-explorer/plugins/*` (the app)

- **`shell`** (exists):
  - The layout becomes `AppShellLayout` + a single full-surface browser pane.
  - The route is `/files?path=…&open=…`, so back / forward is the pane router's history (prototype hist/fwd stacks) and every location is a link.
- **`browser`** (new): `<FileBrowser root path onNavigate embedded?/>`.
  - Toolbar: back / forward / up + `PathBar` + filter.
  - The DataView tree, with fields name / modified / size, folders first.
  - A resizable split to `file-viewer`.
  - The status bar ("N items · "x" selected", folder size · available).
  - Exported from its web barrel so the conversation entry can embed it (`embedded` = no places sidebar, rooted at a worktree, cannot navigate above the root).
- **`places`** (new):
  - `FileExplorer.Place` slot `{ group: "favorites" | "locations" | "worktrees", label, icon, path }`, rendered into `FileExplorer.Sidebar` as a DataView list. Contributors:
    - favorites: Home, Downloads, the equin main checkout (from `infra/spawn` `getMainRepoRoot`);
    - locations: Macintosh HD (`/`, named from `volume`) and Trash (`~/.Trash`, `denied` state handled).
  - The storage meter reads `host-fs volume`.
- **`git`** (new): git awareness when the current path is inside a checkout.
  - A server endpoint `status?path` gives the checkout root, a per-entry status vs `HEAD`, and vs the `main` merge-base. It reuses `code-explorer/server`'s `resolveRefBase` and merge-base logic.
  - Ignored entries come from `git check-ignore --stdin`.
  - Contributes:
    - a status badge field (M / A / ?) on tree rows, via a DataView field contribution;
    - a "Changed vs main" filter;
    - `gitStatus` context into `file-viewer`, which lights up the Diff tab;
    - a "Worktrees" places group: active attempts' worktree paths, labelled by task title.

### 8. Replacing code-explorer

| Today | After |
|---|---|
| Agent-manager sidebar "Explorer" → `code/:worktree` (main) | Removed. The app rail `/files` + the equin place replace it |
| Conversation action-bar "Explorer" → `convFileTreePane` (attempt worktree) | Same button and pane id. The body renders `<FileBrowser embedded root={worktreePath}>` with git on, so diff vs main is preserved |
| `FileTree` (git ls-files, whole tree) | Deleted. Remaining consumer `plugin-meta/plugin-view/file-tree` migrates to `FileBrowser embedded` (or a `host-fs`-backed tree) |
| `/api/code/:worktree/{file,diff,image,push,commit,commit-info,resolve}` (git-ref reads) | **Kept.** They serve refs, diffs, pushes and commits, which host-fs does not. code-explorer shrinks to that git-file API + `code-api` + `commit-detail` + `file-resolve`. Renaming it (e.g. `infra/git/plugins/worktree-files`) is a follow-up |
| `/api/code/:worktree/tree` | Deleted once there are no consumers |

## Phasing

Each phase builds and is usable on its own.

1. **Foundations + app at parity with the mock (defaults).**
   - `host-fs` (list / stat / complete / text / raw / volume / open).
   - The Seti set + `file-type`.
   - The tree extensions (lazy, aligned columns, open gesture).
   - `path-bar`.
   - `file-viewer` with markdown / code / image / fallback.
   - The `browser` + `places` + storage meter.
   - Keyboard map.
2. **Viewers + search.** csv, pdf, Reveal, the `search` walk for the filter, and the Trash `denied` state polish. The conversation `file-pane` becomes a `file-viewer` consumer.
3. **Git + replacement.**
   - The `git` sub-plugin (badges, Changed-vs-main, Diff tab, Worktrees places).
   - Swap the conversation Explorer body to `FileBrowser embedded`.
   - Remove the agent-manager Explorer entry, `FileTree` and `/tree`.
   - Migrate plugin-view.
   - Watcher-backed live listings.
4. **Follow-ups (tasks, not this plan):**
   - file operations (rename / move / delete to Trash, which `infra/trash` does not cover since that is DB-only);
   - prototype variants (colour → app theme, structure → `ui/sidebar-framing`, feel → density);
   - adopt `file-type` in attachments and the pages file block;
   - gateway Host check if missing.

## Critical files

- `plugins/apps/plugins/file-explorer/plugins/shell/web/{index.ts,components/file-explorer-layout.tsx}`
- `plugins/code-explorer/web/{index.ts,panes.tsx,components/file-tree.tsx,components/file-tree-view.tsx}`, `server/internal/{get-file-content.ts,image-handler.ts,resolve-ref.ts}`
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/{slots.ts,components/file-pane.tsx}` + `plugins/{raw,markdown,image,diff}` (moved into `primitives/file-viewer`)
- `plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx`, `plugins/primitives/plugins/tree/web/*` (`TreeList`, `useTreeRow`, `RowChrome`)
- `plugins/primitives/plugins/folder-picker/server/internal/browse.ts` (migrates to host-fs)
- `plugins/ui/plugins/icons/{core,plugins/sprites}` (third set)
- `plugins/primitives/plugins/breadcrumb/web`, `plugins/primitives/plugins/syntax-highlight/web`, `plugins/primitives/plugins/data-table/web`, `plugins/primitives/plugins/overlay/plugins/image-viewer/web`
- New DataView ids each need an authored `config/<plugin>/<id>.jsonc`.

## Verification

- **Unit tests** (`./equin test <plugin>`):
  - `host-fs` list / stat / complete (symlink-to-dir, ENOENT, EACCES on a `chmod 000` temp dir, `~` expansion, hidden flags);
  - the `file-type` table (special names beat extensions, unknown fallback);
  - the csv parser (quotes, embedded newlines);
  - path-bar state machine (jsdom: ⌘L, Tab completion, Esc revert, invalid);
  - lazy tree expand (jsdom).
- **Security checks:**
  - `POST open` with a foreign `Origin` → 403;
  - the `raw` of an `.html` / `.svg` file carries `CSP: sandbox` + `nosniff`;
  - curl with `Host: evil.example` against `:9000` to settle the gateway question.
- **E2E** `apps/file-explorer/e2e/explorer-verify.ts`:
  - open `/files`, ⌘L, type `~/Down`, Tab, Enter → the Downloads listing;
  - expand a folder lazily;
  - double-click to re-root;
  - click a `.md` → rendered preview;
  - an unknown type → the fallback.
- **Prototype compare:** `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1790864772-0r54 --width 1440` at the defaults. Iterate until the regions line up (expect content diffs, since the data is real).
- **Phase 3 regression:**
  - in a conversation, the Explorer button opens its worktree;
  - a modified file shows an M badge and a Diff tab vs `main`;
  - commit and push file peeks still render.
- **Static checks:** `./equin check boundary-rules plugin-boundaries` stays clean (`file-viewer` must not import conversations; the app's `browser` web barrel is imported by the conversation plugin, not the reverse).
