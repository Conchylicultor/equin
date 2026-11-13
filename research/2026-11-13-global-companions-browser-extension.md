# Companions: the Chrome extension, and one panel shared with the menu-bar tray

## Context

The user wants equin reachable from any Chrome tab without opening equin first:
send a wish, jump from the public site (`equin.ai`) to the local instance, and
run app-specific actions on a page (later: add a YouTube song to the music
library). Like the rest of equin, it must update itself when main changes,
with nothing to reinstall.

Design reviewed as prototype `proto-1794537939-tuvpg1`, a popover in the
language of the menu-bar tray mock `proto-1792791657-kzcrw3`. The popover has,
top to bottom:

- a header: the equin logo, "equin", and the status line "2 agents working ·
  1 needs you";
- a **Wish** section: the standard prompt field with its tool row, plus a ↑
  launch button;
- one labelled section per matched site (`equin.ai` → **Open locally**);
- a footer: "Running · equin.localhost".

Decisions taken with the user:

- **Umbrella name: `companions`.** It holds the surfaces equin shows outside
  its own tab. The menu bar moves under it.
- **One look and one set of building blocks for both companions.** The tray
  and the Chrome popover share the panel theme, header, sections and footer.
- **Theme follows the OS (light / dark)** for both companions. The tray is
  light-only today.
- **v1 is Chrome's own popup.** The in-page overlay with rounder, translucent
  corners is a follow-up.
- **The tray's task field becomes the same Wish section** as the popover's:
  the standard field, its tool row and ↑. Tray wishes then file under
  Wishes.

## Architecture

```
Chrome (fixed shell, rarely changes)               equin (updates with main)
───────────────────────────────────                ───────────────────────────
manifest.json  (stable "key" → stable ext id)      /home/browser-extension?embed=1
popup.html → <iframe src=equin…/home/browser-      = Companions panel:
             extension?embed=1>                      header · Wish · page actions · footer
bridge (popup.js): MessagePort handed to the       BrowserExtension.PageAction slot
  iframe on load; requests → chrome.* APIs  ◀──▶   useExtensionHost() (pending/absent/present)
  tabs.query(active) · tabs.update(url) ·
  tabs.create · window.close · action.setBadge
```

- **All work runs in the iframe.** The gateway counts the iframe's own fetches
  and WebSocket as owner, because they are same-origin
  (`gateway/principal.go`; `framework/principal/CLAUDE.md`). A fetch from the
  extension itself counts as anonymous and is refused. So the shell never
  calls equin; it only carries `chrome.*` capabilities.
- **Framing works today.** Nothing sets `X-Frame-Options` or
  `frame-ancestors` on app pages; only the content host
  (`gateway/content.go:94`) does.
- **`?embed=1` already makes a route chromeless**
  (`primitives/embed`, read once by `embedMode()`).

## Plan

### 1. `plugins/companions` umbrella, and moving the menu bar

1. Create `plugins/companions/`, an umbrella with only `package.json` and
   `CLAUDE.md`. Its CLAUDE.md explains:
   - what a companion is (a thin native or extension shell that loads an
     equin route and adds a versioned bridge);
   - the bridge rule: a host offers versioned capabilities, and the page
     hides what an older host can't do.
2. Run `./equin plugin move plugins/menu-bar plugins/companions/plugins/menu-bar`
   (`plugin-meta/relocate`). Then fix what it lists under REVIEW:
   - **`owner:` strings** in `data-dirs/index.ts`, `deps/internal/helper.ts:91`
     and `login-services/index.ts:64` become `"companions/menu-bar"`
     (`ownerForPluginPath`).
   - **Hard-coded paths:**
     - `deps/internal/helper.ts:15` (`CRATE`)
     - `ui/logo/core/internal/files.ts:17` (`HELPER`)
     - `infra/namespace/check/index.ts:172`
     - `product-name/core/internal/legacy-ids.ts:102`
     - the e2e header comments
   - **Dot ids:**
     - the composition negations in `plugin-meta/composition/core/config.ts:664-672`
       (`"!menu-bar.**"`, `"menu-bar.app-window"`) become `companions.menu-bar.*`;
     - the data-view id `menu-bar.apps` stays as it is, because it is a stored
       identity. Exempt it with a reason, as relocate's review asks.
   - **Unchanged:** app id `menu-bar`, route `/home/menu-bar`, endpoint
     `/api/menu-bar/apps`, dep id `menu-bar-helper`, login label
     `dev.equin.menu-bar`. None of them is derived from the path.
3. Run `./equin build` and `./equin check`.
   `relocate:moved-plugins-unnamed` proves nothing still names the old path.

### 2. `companions/panel`, the shared primitive

Extract from `menu-bar/web` everything that is not native-helper specific.
After this, both companions are layouts over this primitive.

- **`CompanionPanel`** (`web/components/companion-panel.tsx`): `Clip` →
  `Surface level="overlay"` → `Scroll` → `Stack` of sections. It is today's
  `MenuBarPanel` body (`menu-bar/web/components/menu-bar-panel.tsx`).
  - It takes the host's section slot as a prop:
    `<CompanionPanel sections={MenuBar.Section} />`.
  - The ordering stays per companion, in each slot's reorder config
    (`config/companions/menu-bar/section.jsonc`, …). There are no numbers on
    contributions.
  - Menu-bar-only behaviour stays in the menu bar: the window material,
    `setPanelHeight`, `StaleReload` and `setAttention`. It passes through as
    props or a mount slot.
- **`PanelSection`** (`web/components/panel-section.tsx`): the one labelled
  section (a caption label such as "Wish" or "equin.ai", then its body).
  Every section uses it, which gives the consistent section titles the user
  asked for. App grid and notifications adopt it too.
- **`CompanionHeader`** and **`CompanionFooter`**: today's `panel-header.tsx`
  and `panel-footer.tsx`. The footer's "Open equin" goes through a host
  callback, with a plain `href` as the fallback.
- **`Companion.Status` slot**: today's `MenuBar.Status`, moved here so both
  headers read it. `conversations/menu-bar-status` (`useAgentsStatus`)
  becomes `conversations/companion-status` and contributes to it.
- **`companionTheme`** (`web/internal/theme.ts`): today's
  `menu-bar/web/internal/theme.ts` with a real **dark** fragment.
  - The dark values come from the prototype: panel `#2b2b2b`, ring `#3d3d3d`,
    tint `rgb(255 255 255 / 8%)`, a sunk prompt field `rgb(0 0 0 / 18%)`.
  - The light values come from the tray. On a solid surface (the Chrome
    popup, which has nothing behind it to blur) the panel is `#e2e6ea`, the
    86% fill as it renders over the wallpaper.
  - Both apps select it (`config/ui/theme-engine/@app/{menu-bar,browser-extension}/theme.jsonc`)
    and declare `colorMode: "system"`. The menu bar's app changes from
    `"light"`. If `defineApp` has no `"system"` value, add it to
    `apps-core`'s color-mode type rather than special-casing it.

### 3. The shared Wish section

Both companions get the same Wish section.

- **In `tasks/task-draft-form`:**
  - Export `TaskDraftComposer` from the barrel
    (`web/components/task-draft-composer.tsx`, today only an exhibit).
  - Add an optional `submit` control to it: the ↑ launch button at the end of
    the tool row (`barEnd`), disabled while the field is empty. ⌘↵ still
    submits (`submitMode="cmd-enter"`).
  - Add a **draft page context** (`DraftPage`): the page the draft is about.
    It has a `url`, and optionally a `pick()` that returns a UI-context chip.
    - The default provider is today's behaviour: `window.location.href`
      captured on open (`task-draft-popover.tsx:489`), with the in-DOM picker.
    - The element picker contribution (`wish/element-picker`) renders only
      when the context can pick. In the extension, where v1 has no
      foreign-tab picker, it disappears. This needs no prop and no
      per-contributor special case.
- **In `wish`:** add a `WishField` component.
  - It holds the draft (`useDraft`, so a closed popup keeps the text) and
    renders `TaskDraftComposer` with `submit`.
  - It submits through the existing `submitChain` with
    `target: {kind:"category", categoryId: WISHES_CATEGORY_ID}` and `url` from
    `DraftPage`.
  - It shows the "Filed — an agent is on …" line inline. A companion shows no
    toasts (`useSuppressToasts`).
  - `wish` contributes it to `MenuBar.Section` and `BrowserExtension.Section`
    as `PanelSection label="Wish"`.
- **`tasks/menu-bar-task` is deleted.** Its root-filing textarea
  (`task-field.tsx`) is replaced by the Wish section. Its `MenuBar.Section`
  entry in the reorder config becomes `wish:wish`.

### 4. `companions/browser-extension`

**Web half:**
- `core/app.ts`:
  `defineApp({ id: "browser-extension", basePath: "/home/browser-extension", listed: false, colorMode: "system" })`,
  following `menu-bar/core/app.ts`. It is hidden from the rail
  (`config/apps-core/app.jsonc`).
- `web/`: the layout is `CompanionPanel sections={BrowserExtension.Section}`.
  - The sections, in order: header, Wish, page actions, footer
    (`config/companions/browser-extension/section.jsonc`).
  - It provides `DraftPage` from the active tab's URL.
- **The `BrowserExtension.PageAction` slot**: `{ id, site: { label, matches(url) }, icon, title, subtitle(url), run(url, host) }`.
  - The page-actions section groups the matching contributions by
    `site.label`. Each group is a `PanelSection`, so section titles stay
    consistent.
  - Rows are the tray's rows: a gradient tile, title, subtitle, and a ⌘N
    shortcut. Running an action shows a spinner, then a check.
- **`core/bridge.ts`**: the contract as zod schemas, mirroring
  `menu-bar/core/native-bridge.ts`.
  - `hostInfo` returns `{ version: 1, shellDigest, capabilities: { activeTab, navigate, openTab, close, badge } }`.
  - Requests: `activeTab() → {url, title}`, `navigate(url)`, `openTab(url)`,
    `close()`, `setBadge(text|null)`.
  - **Transport:** the shell posts a `MessagePort` to the iframe on `load`,
    with the target origin pinned to the equin origin. The page accepts it
    only from
    `event.origin === "chrome-extension://<EXTENSION_ID>"`.
  - The id is stable because the manifest carries a fixed public `key`.
    `EXTENSION_ID` is derived from that key in core, so it can't drift.
- **`web/host.ts`: `useExtensionHost()`.** It reports pending, absent or
  present, like `menu-bar/web/native-host.ts`. Opened in a plain tab, the
  route says it needs the extension. A header attention dot mirrors to
  `setBadge`.

**First page action:** `equin.ai` → **Open locally**, contributed by
`apps/website`. That plugin owns the site:
- Add `PUBLIC_SITE_ORIGIN = "https://equin.ai"` to
  `website/plugins/shell/core/site.ts`, next to `LOCAL_APP_URL`. The help
  menu's hard-coded `GUIDE_URL` (`hints/help-menu/web/components/entries.tsx:19`)
  then reads it.
- Public paths are the local paths (`WEBSITE_BASE_PATH = "/about"`), so the
  mapping is an origin swap: `navigate(LOCAL_APP_URL + path + search + hash)`.
- On the local instance the reverse action, "Open on equin.ai", shows.

**The shell** lives in a new leaf folder kind, `browser-extension/`:
- It is added to the vocabulary in `plugin-id/core/plugin-id.ts` with a
  `boundary-config.ts` row: a leaf, never imported. tsc enforces the row.
- Contents: `manifest.json` (MV3, `action.default_popup`,
  `permissions: ["activeTab", "tabs"]`, `host_permissions` for
  `http://*.localhost/*`, `key`), `popup.html`, and `popup.ts`.
  - `popup.ts` builds the iframe from the target origin, which the build
    writes into `popup.html` as a meta tag.
  - It serves bridge requests with `chrome.tabs`, `chrome.action` and
    `window.close`.
  - There is no background service worker in v1.
- The popup is 440 px wide. Its height follows the content, via a `height`
  request over the bridge (as `setPanelHeight` does), up to Chrome's 600 px
  cap.

**Shipping and self-update:**
- A data dir `browserExtension`
  (`defineDataDir({ kind: "state", owner: "companions/browser-extension" })`)
  maps to `~/.equin/state/browser-extension/`.
- **Main's build** (the `checkout.kind === "main"` branch in
  `framework/cli/plugins/build/cli/run.ts`) bundles the shell with
  `Bun.build` into that dir, targeting the main namespace.
  - It is atomic: write to a temp dir, then rename.
  - It is skipped when the content digest is unchanged (`packages/source-digest`).
  - It stays outside the tracked tree, so the main-tree guard is satisfied.
- **A worktree build** writes its own shell to
  `~/.equin/worktrees/<wt>/browser-extension/`, targeting its own namespace.
  That copy can be loaded unpacked to test a branch, and is never the
  installed one.
- **Self-update, push-based:**
  - The equin page reads the served shell's digest as a live value
    (`serveValue` over the data dir, re-read on build).
  - When it differs from `hostInfo().shellDigest`, the page sends
    `reload()`. The shell calls `chrome.runtime.reload()`, which re-reads an
    unpacked extension from disk.
  - So a shell change applies the next time the popup opens. A popup that is
    never opened needs no update. Everything else (sections, actions, theme)
    is the iframe's content, so it updates with main's dist like any page.
- **Install, once:** `chrome://extensions` → Developer mode → Load unpacked
  → `~/.equin/state/browser-extension`.
  - A Settings → Accounts-style row ("Browser extension: not connected /
    connected, shell up to date") shows the path and the state.
  - "Connected" is known only from inside the popup (`useExtensionHost`), so
    the row reads a small live record the popup writes on open: last seen,
    and the shell digest.

## Follow-ups (filed as tasks, not in v1)

- **The in-page overlay**: rounder, translucent corners on normal pages, with
  the popup as fallback. It needs a content script and `scripting`, and an
  isolated shadow root.
- **A foreign-tab element picker**: a content script provides
  `DraftPage.pick()`.
- **"Add to Chord / Sonata" on YouTube**: page actions contributed by the
  music apps.
- **A keyboard shortcut** (`commands`: `_execute_action` on ⌘⇧E).
- **`frame-ancestors` on `/home/browser-extension`**, limited to the extension
  origin. It is defence in depth; the port check already refuses foreign
  parents.

## Verification

- **Move:** `./equin check` passes, including `relocate:moved-plugins-unnamed`
  and `plugins-registry-in-sync`. The tray still opens: open
  `/home/menu-bar?embed=1` in the browser tools, and run
  `./equin run plugins/companions/plugins/menu-bar/e2e/panel-material.ts`.
- **Look:** the prototype declares
  `<meta name="mocks" content="route:/home/browser-extension">`. Then run
  `compare-diff.ts --name proto-1794537939-tuvpg1` for both the light and
  the dark scheme. Do the same for the tray against `proto-1792791657-kzcrw3`.
- **Unit tests** (`./equin test plugins/companions`):
  - page-action matching and site grouping;
  - the public → local URL mapping;
  - bridge schema parsing;
  - port origin validation, which must refuse a foreign origin.
- **e2e** `companions/browser-extension/e2e/popup-probe.ts`:
  - Playwright `launchPersistentContext` with `--load-extension` pointing at
    the worktree's built shell.
  - Open a fake `equin.ai`-shaped page, then open
    `chrome-extension://<id>/popup.html`.
  - Assert the iframe boots and `hostInfo` resolves. Assert the Wish field
    files a task under Wishes, with the page URL as its source URL. Assert
    Open locally navigates the tab.
  - Assert that a shell digest mismatch triggers a reload.
- **Wish in the tray:** filing from the tray creates a task under the Wishes
  category with no URL attached. There is no source page, so the link toggle
  is off and hidden.
