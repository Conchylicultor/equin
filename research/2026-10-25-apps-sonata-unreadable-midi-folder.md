# Sonata: an unreadable watched MIDI folder is a state the user sees, not a crash

## Context

Report `report-1792896395-ol96qb` (fingerprint `4d5f4424330bf8e6`): macOS denied the gateway (now the
`dev.equin` app) access to `~/Downloads`. `realpathSync` threw `EPERM` in `watchedDirsSync`
(`plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders/server/internal/reconcile.ts:34`),
which handles only `ENOENT`, so the backend crashed with an unhandled error. The user saw nothing in Sonata.

There are two more failures behind the first one:

- **corpus-index** (`plugins/infra/plugins/corpus-index/server/internal/corpus-index.ts:238-265`): `enumerate()`
  tolerates only `ENOENT` per root. One `EPERM`/`EACCES`/`ENOTDIR` root aborts the whole refresh, so no other
  folder reconciles either.
- **file-watcher** (`plugins/infra/plugins/file-watcher/shared/engine.ts:329-350`): a dir that cannot be
  subscribed (missing or denied) rethrows and fails the whole `start`. A *missing* folder today already stops live
  watching for every other folder.

Goal: every configured folder has a typed **status**. The healthy ones keep importing. Each unhealthy one is
shown on the Sonata library page with the folder, the reason, and what the user can do about it. Nothing is
skipped silently.

## Design

### 1. Server: probe each folder into a typed status (folders plugin)

New `server/internal/folder-status.ts`:

```ts
type FolderStatus =
  | { path: string; state: "ok"; realPath: string }
  | { path: string; state: "missing" }        // ENOENT, ENOTDIR on a parent (moved, renamed, drive unplugged)
  | { path: string; state: "not-a-folder" }   // the path is a file
  | { path: string; state: "denied"; code: "EPERM" | "EACCES" }  // macOS privacy / unix perms
  | { path: string; state: "unreadable"; code: string; message: string }; // any other errno, raw
```

- `probeFolders(): FolderStatus[]` runs `realpathSync` and then `readdirSync` (an `opendir` of the root, so a
  folder that resolves but cannot be listed counts as denied, which is the `~/Downloads` TCC case).
- The errno classification reuses host-fs's `classifyFsError`
  (`plugins/infra/plugins/host-fs/server/internal/path.ts:50`, `missing | denied`). It is not exported today, so
  I'd export it from the host-fs **server** barrel rather than copy it.
- An errno it doesn't know (`EIO`, `ELOOP`, …) becomes the `unreadable` arm with the raw code and message. It
  is visible in the UI, not rethrown into a crash and not dropped.
- A non-`ErrnoException` throw still propagates, since that is a genuine bug.
- The module keeps the latest `FolderStatus[]` in memory and fires a change listener only when the statuses
  differ (deep-equal), so the live value pushes only on real changes.

`watchedDirsSync()` becomes `readableDirs()`, the `realPath` of the `ok` folders, read from the current probe.
Its three consumers then all agree on one set:

- the corpus index `roots`, so one bad root can no longer abort the walk;
- the watcher `dirs`, so one bad dir can no longer fail `start`;
- the reverse-drift `stillWatched` check in `reconcileWith`. **This one is load-bearing.** Songs under an
  unreadable folder are *not* flagged "File missing": their files are not known to be gone, only unreadable.
  Their dir is not in `readableDirs`, so they are left untouched, the same as a folder removed from config.

**When the probe runs:**
- in `reconfigure` (boot mount and every config change);
- at the start of every `reconcile()` (the boot warm-up, and the watcher's 30 s `onReconcile` backstop);
- from a new **`POST /api/sonata/midi-folders/recheck`** endpoint (the banner's "Check again").

When a re-probe changes the readable set (for example the user just granted access), it triggers
`reconfigure({ reconcile: true })`. The watcher then picks up the folder and its existing files are imported.

macOS sends no signal when access is granted, so detecting a grant depends on "Check again" and the existing
reconcile backstop. This is user- and event-driven, so no new timer is added.

The remaining gap is TOCTOU: a folder that becomes unreadable between the probe and the walk still throws out of
`ensureFresh`. That is loud, rare, and the next probe classifies it. I'm not widening corpus-index for it.

### 2. Server: serve the status live

- Declare `liveValue("sonata.midi-folders.status", { schema })` in the folders plugin's `shared/`.
- Serve it with `serveValue(…, { source: "external", changes: "notified", loader: currentStatuses,
  whileSubscribed: (_p, notify) => onStatusChange(notify) })`.
- This follows the pattern in `plugins/debug/plugins/live-state-churn/plugins/emit/server/internal/status-value.ts`.
- The array is bounded by the config list, so it carries `unbounded: { reason }` only if tsc asks.
- Add the new fs-touching file to the plugin's existing `boundaries/no-platform-api` debt exemption
  (`exempt/index.ts`, task `task-1792338443-riwqev`, "not yet split into server/ + machine/").

### 3. Web: a notice seam on the library, contributed by the folders plugin

- **`library` gets a `Library.Notice` render slot** (`library/web/slots.ts`, `{ component }`). `SongLibrary`
  renders it as a stack **above the body in both branches**, the DataView and the first-run onboarding. A
  user whose only folder is denied has an empty library, and that is exactly when the notice matters most.
- The library stays source-agnostic and never names MIDI, following the collection-consumer rule. The mail app's
  `Mail.Banner` is the precedent for this shape.
- **`midi/folders/web` contributes `Library.Notice({ id: "midi-folders", component: MidiFoldersNotice })`.**
  It reads the status with `useLive`, renders the loading/error arms through `foldResource`, and on `error`
  shows `ResourceErrorInline`.
- It renders nothing only when the value is ready and every folder is `ok`. It renders one row per unhealthy
  folder:

| State | Says | Actions |
|---|---|---|
| denied | "`~/Downloads` — macOS isn't letting equin read this folder. New MIDI files there aren't imported; songs already imported stay." | **Open System Settings** (Privacy & Security → Files & Folders; a `x-apple.systempreferences:` link), **Check again**, **Remove folder** |
| missing | "… doesn't exist — it may have been moved, renamed, or be on a drive that isn't connected." | **Check again**, **Remove folder**, **Edit folders** |
| not-a-folder | "… is a file, not a folder." | **Remove folder**, **Edit folders** |
| unreadable | "… can't be read: `<code>` <message>" | **Check again**, **Remove folder** |

- **Remove folder** writes the list without that item through `useSetConfig(midiFoldersConfig)`
  (`@plugins/config_v2/web`).
- **Edit folders** opens Settings at the config through `useConfigLink` + `activationProps`
  (`@plugins/config_v2/plugins/config-link/web`).
- **Check again** calls the recheck endpoint (`Button` auto-pends).
- The strip idiom (tone classes, icon, title, body, actions) follows `BannerShell` in
  `plugins/apps/plugins/mail/plugins/sync-status/web/components/mail-sync-banner.tsx:172`, built from the css
  primitives. The final look comes from the approved mock.

### 0. First: the prototype mock (for review before any code)

- Fork `proto-1792667077-4bakda` ("Sonata — library"). Run `./equin prototype new "Sonata — library: unreadable
  folder"` and copy the source's `index.html` into the new folder. The CLI has no fork command, and the user's
  picks file is never touched.
- Set `<title>` and `description`; keep `mocks: route:/sonata`.
- Add options for the user to choose from:
  - `placement: strip | group | chip`:
    - `strip`: a warning strip at the top of the content under the toolbar;
    - `group`: inside the "MIDI files" group header;
    - `chip`: a toolbar chip "1 folder can't be read" opening a popover.
  - `case: denied | missing | several`: the Downloads TCC case, an unplugged drive, and two folders at once.
  - `library: full | empty`: the empty case shows the notice above the onboarding.
- Each variant shows the copy and the actions from the table above. I'll share the variant URLs, and the user
  picks before step 1 starts.

### 4. Sonata settings in the library's pane header (from the mock review)

An audit of the 18 Sonata configs found four that could only be edited in Settings → Config. Each now has a home:

- **Watched MIDI folders.** A gear button in the **library pane's header**, on the right (`sonataLibraryPane.Actions`, not
  the DataView toolbar), opens a "Sonata settings" popover card anchored below it (not a full-height sheet). Its one section is MIDI folders:
  - one row per folder with its live status: "Watching · N songs", "No access from macOS · Allow access · Check again",
    or "Not there · Check again";
  - remove on each row;
  - add with the existing `folder-picker` (the `dirPathField` renderer).

  The rows read the same `sonata.midi-folders.status` value as the notice. The notice's **Change folder…** opens this
  sheet scrolled to that folder.
- **Notation: separate voices, treble/bass split.** These join the notation **View options** in the player: add
  `separateVoices` and `splitPitch` to `fields` in `Sonata.ViewOption` (`notation/web/index.ts`). They don't go in the
  library.
- **Recording sync offset.** Stays internal, with no UI.
- If the mock picks `placement: chip`, the warning chip goes in the same pane header, to the left of the gear.

## Files

- `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders/`
  - `server/internal/folder-status.ts` (new): probe, store, change listener, recheck endpoint impl.
  - `server/internal/reconcile.ts`: `readableDirs()` replaces `watchedDirsSync`; probe at reconcile start.
  - `server/internal/watcher.ts`: probe in `reconfigure`; re-mount when the readable set changes.
  - `server/index.ts`: register the served value and the endpoint.
  - `shared/status.ts` (new): the `FolderStatus` schema, `liveValue`, and `defineEndpoint` for recheck.
  - `web/internal/notice.tsx` (new) and `web/index.ts`: the `Library.Notice` contribution.
  - `exempt/index.ts`: add `folder-status.ts` to the existing debt entry.
  - `CLAUDE.md`: document the status model and the readable-set rule.
- `plugins/apps/plugins/sonata/plugins/library/web/slots.ts` and `web/components/song-library.tsx`: add the
  `Library.Notice` slot and render it above both branches.
- `plugins/infra/plugins/host-fs/server/index.ts`: export `classifyFsError`.
- folders `web/`: the settings button (a `sonataLibraryPane.Actions` contribution) and its popover.
- `plugins/apps/plugins/sonata/plugins/notation/web/index.ts`: two more `fields` in the ViewOption.

## Verification

- **Unit (`./equin test …/folders`):**
  - `folder-status.test.ts` covers a tmp dir that is ok, missing, a file, and `chmod 000` (denied).
  - Extend `reconcile.test.ts`: a song under an unreadable dir is **not** marked missing, and the other dirs
    still enqueue imports.
- **Real app:**
  - Run `./equin build`.
  - Configure a readable folder plus a `chmod 000` folder and a nonexistent path in the worktree's
    `midi-folders` config.
  - The backend stays up and the readable folder's files import (`query_db` on `sonata_songs_ext_midi`).
  - The library shows both notices (`screenshot.ts --path /sonata`).
  - `chmod 755` + **Check again** → the notice clears and the folder's files import.
  - **Remove folder** drops it from the config.
- `./equin check`.

## Follow-ups (not in scope)

- Per-item status inside the Settings list pane.
- A health-report row.
