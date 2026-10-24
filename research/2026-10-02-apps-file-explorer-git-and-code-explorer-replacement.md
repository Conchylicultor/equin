# File explorer phase 3: git awareness, and replacing the code-explorer Explorer

Follows `research/2026-10-02-apps-file-explorer-from-prototype.md` §7 (`git`) and §8 (Replacing code-explorer). Phases 1–2 shipped in `20fbdeac59`.

## Context

`/files` browses the host but knows nothing about git, while code-explorer's Explorer (whole-tree `git ls-files` + `FilePaneView`) still serves the agent-manager sidebar entry and the conversation action-bar button. Two file browsers, and the new one cannot yet stand in for the old one on agent worktrees.

Outcome: one browser. Inside any git checkout it shows per-entry status vs HEAD and vs the `main` merge-base, hides ignored entries, filters "Changed vs main", and previews a changed file with a Diff tab. Places lists active worktrees. The conversation Explorer button opens the new browser rooted at the attempt's worktree. code-explorer shrinks to its git-ref read API, and the unguarded absolute-path reads go away.

### What exists today (measured)

- `FileBrowser({navigator?, initialPath?, root?})` (`apps/file-explorer/plugins/browser/web/components/file-browser.tsx`). With no navigator it keeps local history, which is the embedded mode. `root` caps Up but **not the path bar**, which is a bug to fix here.
- The tree is a `DataView` (`file-explorer.tree`) with inline fields name / modified / size. It has no `fieldExtensions` seam, and `EntryRow` is not exported.
- `PreviewPane` calls `useFileRenderers({file:{source:"host",path}})` and never passes git information.
- `file-viewer` diff `supports` = `file.source==="git" && gitStatus && gitStatus!=="clean"`. So a host file can never get a Diff tab.
- Places: `FileExplorer.Place` is one place per contribution (`usePlace → PlaceState`), and `PlaceGroup = "favorites" | "locations"`.
- code-explorer web: `FileTree`, `FileTreeView`, `globalFileTreePane` (`code/:worktree`, sidebar "Explorer"), `convFileTreePane` (`files`, width 280) and `ConvTreeButton` (`Conversation.ActionBar` id `explorer`). The only outside importer of `@plugins/code-explorer/web` is `plugin-view/file-tree`.
- The unguarded branch is duplicated in `code-explorer/server/internal/get-file-content.ts` and `image-handler.ts`. With no `ref`, an absolute or `~` path is read from anywhere. `file-resolve`'s handler also answers `exact` for an absolute path, so file-peek reads land on that branch too.
  - Absolute-path callers: jsonl `read-image-view.tsx`, `markdown-extensions/img-enhancer.tsx`, `artifacts/screenshot/screenshot-section.tsx` (`item.key`, to verify), and file-peek via `resolve`.
- Git logic to reuse:
  - `computeEditedFiles` (`conversations/…/code/server/internal/compute-edited-files.ts`): merge-base, then `diff --name-status`, then `status --porcelain`.
  - `parseDiffNameStatusZ` (`code-explorer/server/internal/parse-diff-z.ts`).
  - `resolveRef` / `resolveWorktreePath` (`code-explorer/server/internal/`).
  - `createSignedMemo` (`infra/git/git-read-cache`), `withHeavyReadSlot` (`infra/host/host-read-pool`).
  - The `deps.states` pattern (`infra/deps/server/internal/live.ts`): `serveValue` external plus a `whileSubscribed` `defineFileWatcher`.
  - `attemptsResource` (boot-preloaded, has `worktreePath`, `retained`, `active`) plus `tasksResource` for titles. `useLinkedTask` in `tasks/worktree-identity` is the join pattern.

## Design

### A. Git context in `file-viewer` is an overlay, not a source

The diff tab needs "this file has a git status in checkout X". It does not need the bytes to come from git.

- Replace `gitStatus?: FileGitStatus` on `FileRendererTarget` / `useFileRenderers` / `FileView` with:
  ```ts
  git?: { checkout: string; path: string; status: FileGitStatus }
  ```
  - `checkout` is the code-api worktree id. `path` is relative to the checkout.
- The diff renderer's `supports` becomes `target.git && target.git.status !== "clean"`. It renders from `target.git`, whatever `target.file.source` is.
  - So a host file previewed in `/files` (bytes via host-fs raw/text) gets a Diff tab.
- Conversation `file-pane` / `file-peek-pane` derive `git` from their git FileRef plus edited-file status. This is a mechanical change and their behaviour is unchanged.
- One type change, and tsc finds every caller. That is rung 2.

### B. Code-api addresses any checkout, not only known ones

The explorer can be inside any repo (`~/code/foo`), so its diff cannot depend on the checkout being `main` or an attempt.

- `resolveWorktreePath(id)` gains a fourth arm. An absolute path (URL-encoded in `:worktree`) is accepted only if `git rev-parse --show-toplevel` equals it. The result is memoized.
- This does not widen access: host-fs already reads anything the account can (single-principal ADR).
- In return, the ref arms keep their containment (relative path inside the root), and (§E) the no-ref absolute branch disappears.
- `main` / attempt ids still work. The explorer passes the root path, so one code path covers every checkout.

### C. `apps/file-explorer/plugins/browser`: three generic seams

Contributors plug into these seams. The browser never names git.

1. **`FileExplorer.Fields = defineFieldExtensions<EntryRow>()`**, passed as `fieldExtensions` to the tree DataView.
   - `EntryRow` moves to `browser/core` (exported type).
   - Contributed fields with a `value` get Sort and Filter for free (the `PageTree.Fields` / starred model).
2. **`FileExplorer.Lens`** `{ id, useLens: Hook<(root: string) => ExplorerLens> }`, where
   ```ts
   ExplorerLens = {
     hide?: { id; label; icon; isHidden(path): boolean };   // a toolbar toggle, like Show hidden
     fileGit?(path): FileViewerGit | undefined;              // fed to PreviewPane → useFileRenderers({file, git})
   }
   ```
   - It is keyed on the browser's current folder and answers for any depth, so lazily expanded subfolders are covered.
   - The browser composes every lens: the union of active hide rules, and the first `fileGit` that answers.
   - Each `hide` toggle persists via `useDraft`, like Show hidden.
3. **Fix:** the path bar's `validate` / `complete` refuse paths outside `root`, so an embedded browser cannot escape its root.

Also, for consumers that bring their own preview (plugin-view), `FileBrowser` gets `onOpenFile?: (path) => void`. When it is given, there is no split preview, and the open gesture delegates.

### D. `apps/file-explorer/plugins/git` (new)

**Server.** The server answers two questions.

- `GET /api/file-explorer/git/checkout?path` → `{kind:"none"} | {kind:"checkout", root}`.
  - Runs `rev-parse --show-toplevel`, memoized per directory.
  - It is cheap and is called when the folder changes.
- Live value `fileExplorer.gitStatus` with params `{root}` (`serveValue`, source external) →
  ```ts
  { head, mergeBase: string|null,
    entries: Record<relPath, { vsHead: Status|null, vsMain: Status|null }>,
    ignoredDirs: string[], ignoredFiles: string[], untrackedDirs: string[] }
  ```
  - **Compute:** `createSignedMemo`, keyed by root, with a signature of HEAD sha + index mtime. The compute runs inside `withHeavyReadSlot`:
    - `merge-base main HEAD`, then `diff -M -z --name-status <mergeBase>` for vs main. `computeEditedFiles`' pieces and `parseDiffNameStatusZ` are hoisted to a shared server export rather than copied.
    - `status --porcelain=v2 -z --untracked-files=normal --ignored=traditional` for vs HEAD, untracked and ignored.
      - Untracked and ignored directories come back collapsed as `dir/`, so the payload is bounded by what changed, never by tree size.
      - The client resolves descendants by prefix.
    - This replaces a per-folder `check-ignore --stdin`: one call for the whole checkout, already collapsed.
  - **Freshness:** `whileSubscribed` starts a `defineFileWatcher` on the root plus its git dir (`HEAD`, `index`, `refs`). The watcher ignores `.git/objects`, `node_modules` and ignored dirs, and calls `notify()`.
    - The watcher exists only while a browser is in that checkout. No polling.

**Web.** One hook, `useGitStatus(root)`, feeds three contributions.

- `FileExplorer.Fields` adds:
  - `git`: an enum badge M / A / D / R / ? from `vsHead ?? vsMain`. A folder shows a dot when any descendant changed.
  - `changed`: a bool, "Changed vs main", which becomes the Filter pill.
- `FileExplorer.Lens` gives:
  - `hide = Show ignored`, hidden by default;
  - `fileGit(path) = {checkout: root, path: rel, status}`, which lights up the Diff tab against the merge-base, as conversation file-pane does today.
- While status is pending, badges render as pending. They are never shown as clean (the not-known-yet rule).

### E. Places: sources, plus a Worktrees group

> **Dropped after review (2026-10-02):** the Worktrees group was built, then removed at the user's request. The slot change to sources stays; `worktree-places` and `PlaceGroup` `"worktrees"` were deleted.

- **Slot change.** `FileExplorer.Place` becomes `FileExplorer.Places` `{ id, group, usePlaces: Hook<() => PlacesState> }`, where `PlacesState` is pending / ready (list) / failed.
  - The five existing places become sources of one.
  - `PlaceGroup` gains `"worktrees"`.
  - This gives one shape for a fixed place and a dynamic set, rather than two slots.
- **New `apps/file-explorer/plugins/worktree-places`** keeps `places` free of tasks.
  - It reads `attemptsResource` filtered to `retained` and joins `tasksResource` for the title, as in `useLinkedTask`.
  - Each place's path is `worktreePath`, its label is the task title (basename as fallback), and its icon is a branch glyph.
  - Clicking it opens `/files` at the worktree, where git (D) lights up.

### F. Conversation entry

- **New `conversations/plugins/conversation-view/plugins/explorer`** takes over `ConvTreeButton`, the `Conversation.ActionBar` id `explorer`, and the `convFileTreePane` id / segment `files`.
- The body is `<FileBrowser initialPath={wt} root={wt}/>`, with `wt = conversation.worktreePath` and git on automatically via D.
- The pane width goes from 280 to roughly 960 (tree plus preview), with `promote` kept off.
- The dependency direction is conversation → `apps/file-explorer/browser/web`, never the reverse.

### G. Remove the old Explorer and the unguarded reads

- **Delete from `code-explorer/web`:** `FileTree`, `FileTreeView`, `panes.tsx`, the conv/global bodies, `ConvTreeButton` and the `Shell.Sidebar` "Explorer" entry.
  - `code-explorer` keeps only `server` plus the `code-api` / `commit-detail` / `file-resolve` sub-plugins. Its CLAUDE.md is updated.
  - Delete `e2e/file-tree-expand.ts`; the new e2e below replaces it.
- **Delete** `GET /api/code/:worktree/tree` (`getCodeTree`, `tree-handler.ts`).
- **`plugin-view/file-tree`:** `<FileBrowser initialPath={pluginDir} root={pluginDir} onOpenFile={p => openPane(filePeekPane, {worktree:"self", filePath: rel(p)})}/>`.
  - `pluginDir` is the absolute plugin folder of this checkout. The `places` checkout endpoint returns `{main, self}`, and `self` is `REPO_ROOT`.
  - Nested `plugins/` now shows as a folder rather than being filtered out. This is intended: it is a browsable folder.
- **`/file` and `/image` with no `ref`:** only relative paths inside the root are accepted. Absolute and `~` paths return 400. The duplicated `expandTilde` branches go.
- **Migrate callers through one helper** in `file-viewer/core`:
  ```ts
  fileRefForPath(worktree, p): FileRef
  ```
  - An absolute or `~` path inside the worktree becomes `git` (relative). Any other absolute or `~` path becomes `host`. A relative path becomes `git`.
  - `read-image-view`, `img-enhancer` and `screenshot-section` use `fileUrl(fileRefForPath(…))`. So `/api/host-fs/raw` serves outside-worktree images, with CSP sandbox and nosniff.
  - `file-resolve`'s `exact` answer carries the resolved `FileRef`, so file-peek of an absolute path reads from host-fs or git correctly.

### Out of scope (follow-up tasks)

- Watcher-backed live *listings* (folder contents). Today a folder is re-listed on each visit. The git status in D is live; listings are a separate host-fs change.
- The host-fs `search` walk, and the csv / pdf viewers (phase 2 leftovers).
- Renaming the slimmed code-explorer (e.g. `infra/git/plugins/worktree-files`).

## Order of work

Each step builds on its own.

1. Make the `file-viewer` `git` overlay (A) and the code-api checkout-path arm (B).
2. Add the browser seams (C), with the path-bar root fix and `onOpenFile`.
3. Add the `git` sub-plugin (D).
4. Do the Places slot change and add `worktree-places` (E).
5. Add the conversation `explorer` plugin (F).
6. Remove the old Explorer and the absolute reads, and migrate plugin-view (G).

## Critical files

- `plugins/primitives/plugins/file-viewer/{core/file-ref.ts,web/slots.ts,plugins/diff/web/internal/supports.ts}`
- `plugins/apps/plugins/file-explorer/plugins/browser/web/components/{file-browser.tsx,file-tree.tsx,preview-pane.tsx}`
- `plugins/apps/plugins/file-explorer/plugins/shell/web/slots.ts`
- `plugins/apps/plugins/file-explorer/plugins/places/web/internal/places.ts`
- `plugins/code-explorer/server/internal/{resolve-worktree-path.ts,get-file-content.ts,image-handler.ts,tree-handler.ts}`
- `plugins/code-explorer/web/*` (deleted)
- `plugins/code-explorer/plugins/code-api/core/endpoints.ts`
- `plugins/code-explorer/plugins/file-resolve/{shared/endpoints.ts,server/internal/resolve-handler.ts}`
- `plugins/conversations/plugins/conversation-view/plugins/code/{server/internal/compute-edited-files.ts,plugins/file-pane/web/*}`
- `plugins/plugin-meta/plugins/plugin-view/plugins/file-tree/web/components/file-tree-section.tsx`
- jsonl `read-image-view.tsx`, `markdown-extensions/web/internal/img-enhancer.tsx`, `artifacts/plugins/screenshot/web/components/screenshot-section.tsx`

## Verification

- **Unit tests:**
  - the porcelain-v2 / name-status → entries parser, including collapsed untracked and ignored dirs and renames;
  - descendant resolution (a path under `node_modules/` counts as ignored, a folder dot rolls up);
  - `fileRefForPath` for each arm;
  - `resolveWorktreePath` rejects a non-toplevel path;
  - `/file` and `/image` reject absolute and `~` paths without a ref.
- **E2E** `apps/file-explorer/plugins/git/e2e/git-verify.ts`, after `./equin build`:
  - open `/files` at this worktree and touch a file;
  - assert the M badge and that "Changed vs main" narrows the rows;
  - assert that `node_modules` is hidden until Show ignored is on;
  - open the file and confirm the Diff tab renders;
  - Places shows Worktrees with task titles;
  - in a conversation, the Explorer button opens the browser rooted at its worktree, and Up stops at the root.
- **Regression:**
  - file peeks from chat, review and commits still render, including the diff;
  - a Read-tool image with an absolute path still shows;
  - a markdown image with a `~` path still shows;
  - the plugin-view Files section lists and opens files.
- **Static:** `./equin check` (boundary-rules, plugin-boundaries, plugins-registry-in-sync, plugins-doc-in-sync).
