# Browser app: tabs survive a reload, and file uploads work

## Context

Two gaps in the streamed-Chromium Browser app
(`plugins/apps/plugins/browser`, engine design:
`research/2026-10-24-apps-browser-streamed-chromium.md`):

1. **Tabs are lost on reload.** The tab list lives only in the per-surface
   scoped store (`shell/web/nav-store.ts`, `defineScopedStore`). The engine
   host keeps every remote page alive (frozen after 1 min, closed 30 min after
   its last viewer), so after a reload the pages are still there — nobody
   remembers their keys.
2. **File inputs do nothing.** `<input type=file>` opens the native chooser in
   the off-screen engine Chromium, which the user never sees.

## 1. Tab restore

### Model

The browser's tab set is **one per browser** (the user's Chrome window), not
one per surface: reloading, rail-switching away and back, or opening the
Browser app in another tab/window all show the same tabs. It is persisted in
the browser (Web Storage) through the one sanctioned door,
`primitives/dom/web-storage` `defineStore`:

```ts
const savedTabs = defineStore({
  owner: "apps.browser.tabs", label: "Browser tabs", area: "local",
  cap: "128 KB", ttl: Infinity, whenFull: "refuse", schema: SavedTabsSchema,
});
// one entry, id "tabs": { tabs: SavedTab[]; activeKey: string }
// SavedTab = { key, url, pageUrl, title, faviconUrl }
```

Why Web Storage, not a DB table: it is synchronous (the store is seeded in
the Provider's initial factory — no loading state, no first-paint flash of a
fresh start-page tab), and the per-surface transient half (requests, sentSeq,
`remote`, pendingCloses) stays in the scoped store untouched. A tab whose page
expired on the host revives with no new code: `attach {key, url}` already
creates the page at `url` when the key is unknown.

### Store changes (`shell/web/nav-store.ts`)

- **Tab id = remote key.** `freshTab` uses the key as `id` (drop `tab-<seq>`),
  so a tab is the same entity in every surface and in storage. `seq` keeps
  ordering requests only.
- **Seed** (`initialState`): read `savedTabs.read("tabs")`; a `value` maps each
  saved tab to a `BrowserTab` with `remote: pageUrl !== ""` (an attach was
  sent before), `loading: false`, `canGoBack/Forward: false` (corrected by the
  first `state` on attach), `request: null`; active = `activeKey` if present.
  `none` → today's single fresh tab. Favicons that are `data:` URLs are not
  saved (size); the Favicon component's fallback covers them until attach.
- **Sync** — a `PersistBrowserTabs` effect component the layout mounts inside
  the Provider:
  - store → storage: on every store change, project to `SavedTabs`; write when
    the JSON differs from the last one written/read. A refused write is already
    loud (web-storage toast + health row).
  - storage → store: `savedTabs.subscribe("tabs", …)` (fires for same-document
    and other-document writes). An incoming list that differs from the last
    seen is **merged** by key: kept tabs keep their transient fields and take
    the saved fields; new keys are added (`remote` as in seeding); missing keys
    are dropped (closed elsewhere — the closer already queued the host close).
    The local `activeId` stays when still present, else the neighbour.
    `activeKey` from another surface is not adopted (each surface keeps its own
    selection; only seeding reads it).

### Two viewers of one page

With a shared tab set, two surfaces can show the same tab. The host keeps one
socket per page ("a newer attach wins") and closes the older one with 4000 —
the reconnecting socket's own close sentinel, so today the displaced view just
freezes silently. Make it explicit:

- Protocol: host event `displaced` (sent right before the 4000 close).
  `ENGINE_PROTOCOL` → 2.
- `RemoteTab` on `displaced`: a centred card over the last frame — "This tab
  is showing in another window" + **Show here** (remounts `RemoteTab`, i.e. a
  fresh attach, which displaces the other one in turn).

## 2. File uploads

Playwright intercepts the chooser once a `filechooser` listener exists (no
native dialog opens). Bytes travel over the tab's existing socket, so nothing
new is routed through the gateway/relay (the relay already passes binary
both ways).

### Protocol (`engine/core/protocol.ts`)

- host → client `fileChooser {multiple: boolean, accept: string}` — resent on
  attach while pending (like `dialog`).
- client → host `files {files: [{name, type, size}]}` — the answer; `[]` =
  cancel. It is followed by each file's bytes, in order, as **binary client
  messages** of ≤ 256 KB.
- host → client `upload {received, total}` after each chunk is written: the
  flow control (the client keeps ≤ 4 chunks in flight, sending the next on
  each ack — push-based, no `bufferedAmount` polling) and the progress bar.
  `upload` with `received === total` = done.

### Host (`engine/bin/host-pages.ts`)

- `page.on("filechooser")` → `rp.chooser = fc` (newest wins) + send
  `fileChooser` (`fc.isMultiple()`, the input's `accept` attribute via
  `fc.element()`).
- `files`: no pending chooser → `error`. `[]` → drop the chooser. Otherwise
  open `ws.data.upload = {chooser, files, index, written, dir}` and stream
  chunks with Bun's file writer into
  `browserEngineUploadsDir/<page key>/<uuid>/<name>` (name sanitised to its
  basename). Binary messages are accepted only while an upload is open
  (otherwise the existing "binary client message" refusal). On the last byte:
  `chooser.setFiles(paths)`, `upload {total,total}`, clear the chooser.
- Uploaded files stay on disk while their page lives (Chromium reads a picked
  `File` from its path lazily, when the page submits it): the page's dir is
  removed in `forget`, and the whole uploads dir is emptied when the host
  starts.
- New data dir in `engine/data-dirs`: `cache/browser-engine-uploads`
  (reclaim `restart`, as the engine's services dir — a live page may be
  reading them).

### Client (`webview`)

New `FileChooserPrompt` (a `Dialog` like `PageDialog`): title "Upload files" /
"Upload a file", the accepted types as a hint, a drop area for files dragged
from the desktop, and **Choose files…** (a hidden `<input type=file>` with the
page's `multiple`/`accept` — a user click, so the browser lets it open).
Cancel / Escape answers `files []`. After picking: the dialog shows the
upload's progress (`upload` events) and closes when done. The prompt is
needed because the event arrives over a socket, with no user activation to
open a picker directly.

## Files

- Edit: `browser/shell/web/nav-store.ts` (+ new `shell/web/internal/saved-tabs.ts`:
  the store + schema + merge, `shell/web/components/persist-tabs.tsx`),
  `shell/web/components/browser-layout.tsx` (mount it).
- Edit: `browser/engine/core/protocol.ts`, `engine/bin/host-pages.ts`
  (+ maybe `engine/bin/host-uploads.ts`), `engine/bin/host.ts` (sweep on
  start), `engine/data-dirs/index.ts`.
- Edit: `browser/webview/web/components/remote-tab.tsx`; new
  `webview/web/components/file-chooser.tsx`, a `displaced` card.
- Tests: `shell` merge/seed logic (pure, `*.test.ts`); update the engine
  design doc's out-of-scope list.

## Out of scope

Dropping files straight onto the page canvas (drag events into the remote
page); tab reordering; syncing tabs across devices.

## Verification

1. `./equin build`; with `browser_*` on this build: open `/browser`, open 3
   tabs on real sites, reload → same tabs, same titles, the active one streams
   (its page kept: scroll position/back history survive).
2. Two surfaces on `/browser`: open a tab in one → appears in the other;
   close it → gone in both; select the same tab in both → the older shows
   "showing in another window", Show here swaps.
3. Upload: a page with `<input type=file>` (e.g. a `data:` test page or
   https://www.w3schools.com/tags/tryit.asp?filename=tryhtml5_input_type_file):
   click → the prompt; pick a file via `browser_*` file input → the page's
   input shows the file name (read `input.files[0].name` via the page).
4. `./equin test plugins/apps/plugins/browser`, `./equin check`.
