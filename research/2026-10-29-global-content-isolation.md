# Trust boundaries, Phase 3 — content isolation

Track: wiki page *Trust boundaries* (`block-f3f30a77…`), design in its sub-page
*End vision* → "Content isolation (principle 3)". Phases 1 (HTTP edge,
`research/2026-10-28-global-http-edge-principal.md`) and 2 (native edge,
`research/2026-10-28-menu-bar-native-edge-pin.md`) are done.

## Context

Agent-written prototypes are framed `sandbox="allow-scripts allow-same-origin"` on
the app's own origin. A sandbox that grants `allow-same-origin` to a same-origin
document is a no-op: the prototype can call every `/api` route as the owner (it
sends the owner's `Sec-Fetch-Site: same-origin`), reach `top`'s DOM, and even
remove its own sandbox. A page embed of an equin URL is the same hole. Phase 1
cannot see it: same-origin content IS the owner to every check.

Done when: untrusted active content never runs on an app origin, every frame goes
through one primitive, nothing else in the repo can frame with
`allow-same-origin`, and a live probe shows it.

## Inventory (2026-10-29)

| Surface | What it frames | Today | Verdict |
|---|---|---|---|
| Prototype canvas (`apps/prototypes/canvas/…/prototype-frame.tsx`, 2 iframes) | agent-written HTML | `allow-scripts allow-same-origin`, app origin; parent reads `contentDocument` | **hole** |
| Prototype page block (`page/prototype/…/prototype-block.tsx`) | agent-written HTML | same | **hole** |
| Present (`apps/prototypes/present`) | reuses the canvas frame; listens into `contentDocument` for pointer idle | same | **hole** (via canvas) |
| Page embed (`page/embed/…/embed-block.tsx`) | any pasted URL; no scheme check, no equin check | `allow-scripts allow-same-origin allow-popups…` | **hole for equin / loopback / `javascript:` URLs**; fine for YouTube & co |
| File-viewer HTML (`file-viewer/html`) | host `.html` files | `srcDoc`, opaque sandbox, CSP | OK — moves onto the primitive |
| File-viewer PDF (`file-viewer/pdf`) | host PDF asset | no sandbox (PDF viewer needs it), served `application/pdf` + nosniff | OK — moves onto the primitive |
| Worktree preview (`open-app/…/app-preview-pane.tsx`), compare "Real app" (`compare/route/…/route-counterpart.tsx`) | the app itself (trusted code) | no sandbox | OK — moves onto the primitive as an app frame |
| Mail HTML | sanitized (DOMPurify), inline, no scripts | — | OK while the sanitizer holds (sidequest below) |
| Browser app | canvas screencast, no iframe | — | OK |

What prototypes actually need from same-origin (128 sampled): relative sub-files
(82 `.js`, 25 `.css`, images, 5 extra `.html`), `localStorage` (6 prototypes), and
nested frames of their own files. None call `/api`, none use absolute paths. The
**parent** is the real dependency: scroll carry, live colour vars,
`--prototype-screen-height` + `resize`, the whole-page extent probe and height
observers — all via `contentDocument`.

So an opaque sandbox would break prototypes (their own files are refused as
cross-site, `localStorage` throws). They need a **content origin**.

## The content origin — what it is

Content gets its own hosts: **`http://<item>.content.localhost:9000/<ns>/…`**. They
are where equin serves *content* (pages that run script but are not reviewed app
code), as opposed to `<ns>.localhost:9000`, where it serves the *app*.

- **`<item>` — one origin per piece of content.** The standard user-content shape
  (`*.googleusercontent.com`, `<user>.github.io`, `<id>.csb.app`): fixed domain on
  the right, per-item label on the left. For a prototype the item is its id
  (`proto-1790778230-7qkl`): its live folder, every version, every option variant
  and its nested pages share one origin (so its own `localStorage` follows it
  across canvas, page block, conversation card and Present), while two prototypes
  can no longer read each other's storage, script each other, or intercept each
  other with a Service Worker. The key is derived by the primitive from the
  content route's own parameter (`:name`), never passed by a caller; it must be a
  DNS label (lowercase, ≤ 63 bytes).
- **`/<ns>/` — routing, not identity.** The first path segment picks the namespace
  backend (alias-resolved like a Host: `equin` → main), so a worktree's content is
  served by the worktree's own code. The same item from two namespaces shares an
  origin: prototype files are host-global, so it IS the same content. This leaves
  the namespace grammar (`<composition>.<checkout>`) untouched and resolves the
  End vision's open question.
- **Why `<item>.content` and not `content.<item>`:** DNS reads general → specific
  right to left; `content.<item>.localhost` would parse as a `<composition>.<checkout>`
  namespace, make each item a site of its own next to the app sites, and defeat
  a hosted `*.content.<domain>` wildcard certificate.
- **A different site** from every app origin (`content.localhost` vs
  `<ns>.localhost`): its own browser process under site isolation, its own storage,
  no `document.domain` path back, and every request it sends to an app origin is
  cross-site, so Phase 1 makes it anonymous. Hosted, the content domain can go on
  the Public Suffix List (like `github.io`), making each item its own site too.
- **What the gateway serves there**: only `/api/…` routes a backend declared as
  content, proxied with the principal stamped `content`. No SPA, no `/ws`, no
  `/gateway`, no central routes: all 404. It refuses Service Worker script
  requests (`Service-Worker: script`), and adds `Content-Security-Policy:
  frame-ancestors 'self' http://*.localhost:9000` (only equin pages may frame it)
  and `Cross-Origin-Resource-Policy: same-origin`, so no backend can forget them.
  `content` and `*.content` are reserved names (`namespaceCollision`), like the
  `equin` alias.
- **Where it shows up**: only in the `src` of content frames (prototype canvas,
  page block, conversation artifact cards, Present). Never the app's address bar;
  nobody types it; URLs are never stored (blocks store the prototype id), so the
  scheme can change freely. Old `/api/prototypes/…` links on an app host redirect.
- **Not only prototypes**: any future untrusted page that must be a real web page
  with its own files (agent-written HTML artifacts, marketplace plugin UIs) is a
  route declared as content. Today prototypes are the only user.
- **Hosted**: `*.content.<domain>` (ideally its own registrable domain); same shape.
- **Rollout handshake** (as in Phase 1): the gateway declares
  `--content-host` on each backend's argv. Behind an older gateway the transport
  has no content base and a prototype frame renders a loud "gateway out of date —
  `./equin start --force`" state, **never** a fallback to the app origin.

## Design

### 1. Gateway (`gateway/proxy.go`, `principal.go`)
- A `<item>.content.localhost` Host is handled at the top of `ServeHTTP` (before
  `parseWorktree` and central routes): check the item label's syntax, split
  `/<label>/rest`, resolve the label through `hostAliases`, refuse anything but
  `/api/` rest, Service Worker scripts and WebSocket upgrades, strip any client
  principal header, stamp `content`, add the headers above, proxy `rest` to that
  namespace's backend.
- `principalOf`: a request to the content host is never `owner`.
- Go tests beside `principal_test.go` / `proxy_test.go`.

### 2. Namespace (`infra/namespace/core`)
- `CONTENT_HOST_LABEL = "content"`, `contentUrl(item, ns, path)` →
  `http://<item>.content.localhost:9000/<label><path>`, and the parse back. These
  are the only spellings (`namespace:no-hand-built-url`). `content` is added to
  the reserved names (`namespaceCollision`), and `namespace:grammar-in-sync` pins
  the Go constant.

### 3. Principal (`framework/principal`)
- `Principal = owner | anonymous | content`; `principalOf` stays fail-closed.
- `EndpointAccess = "owner" | { public: reason } | { content: reason }`.
- `gateByPrincipal`: a content route is served only to `content`; an owner request
  to it gets a 308 to its content URL (old links); anonymous gets 403. Every other
  route refuses `content` (`403 content-refused`). The route table gains
  `access: "content"`; the cross-site probe counts content routes as refused for
  anonymous (unchanged 353/353 semantics).
- A content route's `text/html` responses get the **frame agent** injected by the
  gate wrapper itself (below). The route cannot forget it.

### 4. The frame primitive: `plugins/primitives/plugins/embed/plugins/frame`
`primitives/embed` owns the embedded document's side (`?embed=`); this child
plugin owns the host's side. Every `<iframe>` in the repo is one of:

| Component | Takes | Sandbox | For |
|---|---|---|---|
| `ContentFrame` | an `AssetPath` of a content route (+ transport) | `allow-scripts allow-same-origin allow-forms allow-popups allow-modals` — same-origin = the content origin; never top-navigation | prototypes |
| `ForeignFrame` | a URL, classified by `classifyFrameUrl` | today's third-party flags | page embeds |
| `InlineFrame` | an HTML string | opaque (`srcdoc`, no `allow-same-origin`) + `isolateHtml`'s CSP | file-viewer HTML |
| `PdfFrame` | an `AssetPath` | none (the PDF viewer needs it) | file-viewer PDF |
| `AppFrame` | a namespace + an app route (typed, never a URL) | none | worktree preview, compare "Real app" |

- `allow-same-origin` is spelled in one file, and only for URLs the primitive
  built itself (content) or classified as foreign.
- **`classifyFrameUrl(url)`** (core, pure): `foreign` only for http(s) to a host
  that is not an equin namespace (`namespaceFromHost`), not the content host, not
  loopback/IP-literal; otherwise `refused` with a reason. The embed block renders
  the refusal ("equin pages can't be embedded" + Open original) instead of a
  frame.
- **The channel** (`FrameChannel`, replacing every `contentDocument` read): on
  `load` the parent posts a `MessagePort` to `contentWindow` (target origin = the
  content origin exactly). A closed protocol, zod-parsed on both sides:
  parent→frame `setVars`, `setScreenHeight` (writes `--prototype-screen-height` +
  `resize`), `captureScroll` → `DocumentScroll`, `restoreScroll`,
  `probeExtent(heights)`; frame→parent `height` (observed), `activity` (pointer /
  key, for Present's idle). **Replies are untrusted data**: the prototype shares a
  realm with the agent and can forge them; they are numbers, bounded and
  validated, and never trigger anything but layout.
- **The frame agent** (`core/frame-agent.ts`): one import-free function serialized
  into an inline `<script>` at the start of `<head>` by the content gate. It
  absorbs `captureDocumentScroll` / `restoreDocumentScroll`, which `auto-scroll`
  exports only for this same-origin iframe case. They move here and leave
  auto-scroll, with a sanctioned `scroll-safety` exemption for the agent file. A
  unit test asserts the function references no outer binding.
- **Transport**: `frameBase` becomes `contentBase: { kind: "origin"; base } |
  { kind: "same-origin"; prefix; reason } | null`.
  - `pageTransport`: content URLs for `namespaceFromHost(location.host)` when
    the gateway declares the content host, else `null`.
  - The in-browser demo (`browserServerTransport`): `same-origin` with the reason
    "repo fixture content; the page holds no owner authority", served by its
    Service Worker as today, through the same channel.
  - `frameUrlOver` becomes `contentUrlOver`.
- **Lint** `frame/no-raw-frame` (the plugin's `lint/`, `noDebt`): flags JSX
  `<iframe>` / `<frame>` / `<object>` / `<embed>`, `createElement("iframe" | …)`,
  and `srcdoc` writes outside the primitive. The primitive's own file is a
  sanctioned exemption. `enforceEverywhere` is not needed: e2e attacker pages are
  strings.

### 5. Migrations
- `apps/prototypes/files`: the file and version routes declare
  `access: { content: "agent-written prototype documents, served off the app origin" }`.
  Picks stamping is unchanged. The other prototype routes stay owner.
- `apps/prototypes/canvas`: `prototype-frame.tsx`, `internal/page-extent.ts`,
  `use-page-height.ts`, `color-vars.ts` → `ContentFrame` + channel (async; the
  hidden twin / swap-on-load model is unchanged). `present/use-pointer-idle.ts` →
  `activity` events. `canvas/e2e/canvas-size.ts:231` → Playwright's frame API
  (works cross-origin, like `compare-diff.ts` already does).
- `page/prototype` → `ContentFrame`; `page/embed` → `ForeignFrame`;
  `file-viewer/html` → `InlineFrame`; `file-viewer/pdf` → `PdfFrame`;
  `open-app` preview and `compare/route` → `AppFrame`.
- Thumbnails render off `file://`: unaffected.
- Docs: `prototypes/CLAUDE.md` (the authoring contract: a prototype runs on the
  content origin and cannot reach the app), `principal`, `gateway`, `namespace`,
  `networking` (transport) CLAUDE.md files; End vision page (open question
  resolved, target updated).

### 6. Live probe: `primitives/embed/frame/e2e/content-probe.ts`
Same shape as `cross-site-probe.ts` (harness `report`, `withBrowser`).
- **Setup**: mints a hostile prototype through the real write path
  (`apps/prototypes/fixtures`, removed in `finally`), opens it in the canvas of
  this checkout's deploy.
- **Rows the hostile document runs, each reported back over its own channel to a
  probe sink**, every one expected to be denied:
  - same-host `/api/host/routes`
  - an owner write on the app origin
  - a WebSocket to the app
  - `top.document`
  - `top.location =`
  - `window.open` of the app, then scripting it
  - reading the app's `localStorage`
  - a forged channel reply (the parent's state is unchanged)
- **Rows checked from outside**: a content URL on the app host as owner is
  redirected, not served; a page embed of an equin URL renders the refusal and no
  frame.
- **Positive rows**: the prototype's own relative file, `localStorage`, and a
  colour pick painted through the channel.
- **Negative control**: the same hostile script `page.evaluate`d in the app's own
  realm turns the denial rows red, so the probe tests something.

## Order of work (one session)
1. Namespace + principal core + Go gateway (tests).
2. The frame primitive (core protocol, agent, `classifyFrameUrl`, components,
   lint) + transport `contentBase`.
3. Migrate the call sites; delete `frameBase` / `frameUrlOver` and auto-scroll's
   document-scroll pair.
4. `./equin check`, `./equin test` on the touched plugins, `./equin build`.
5. The gateway must be restarted to serve the content host. That is
   `./equin start --force`, which **only the user runs** (CLAUDE.md forbids it
   otherwise): I ask, then run the probe and the canvas e2e scripts
   (`canvas-frames`, `canvas-size`, `canvas-version`, `canvas-remember`,
   `compare-diff`).
6. Update the track page (Phase 3 done, its design link) and file the next main
   task.

## Verification
- Unit tests: `classifyFrameUrl`, the gate's content arms, the channel protocol
  (forged / malformed replies), the agent's self-containment, the lint
  (`RuleTester` with JSX), Go content-host routing and stamping.
- `./equin check` (incl. `namespace:grammar-in-sync`, `principal:header-in-sync`,
  `frame/no-raw-frame` with zero debt).
- Live: `content-probe.ts` all rows held, negative control red;
  `cross-site-probe.ts` still 353/353 (plus content routes); the canvas e2e scripts
  green; a page with a prototype block and a YouTube embed checked with
  `browser_*`.

## Out of scope / sidequests
- Mail HTML stays sanitize-and-inline. Moving it into an `InlineFrame` (opaque)
  would remove reliance on DOMPurify: sidequest.

## As built (2026-10-29)

Departures from the plan above, and why:

- **No rollout handshake.** Behind an older gateway a content frame 404s inside
  itself — visible, not insecure — and the health report's Gateway row already
  flags any gateway source drift. The transport derives the content host from
  `location` (`null` on a host that is no namespace).
- **No redirect for an app-origin request to a content route**: it answers
  `403 content-only`. The gate lives in `framework/principal`, which cannot
  build a content URL (no namespace dependency); nothing in the app links there
  any more (`prototype options` prints the content URL).
- **The agent and protocol are their own leaf** (`primitives/embed/frame/plugins/agent`):
  `infra/endpoints` injects the agent and the frame's web half imports
  endpoints, so one plugin would be a cycle.
- **Whole page, measured cross-origin**: the extent probe compares the
  document's CONTENT height at one screen and at two (async, over the
  channel). A page sized in CSS `vh` now reads as following its window (the
  old synchronous same-origin read could tell it apart from a script-sized
  one); `--prototype-screen-height` keeps a whole page, as the authoring
  contract says. A page that gets shorter in Whole page keeps its taller frame
  until reloaded.
- **Present's idle**: activity inside a content frame reaches the parent as the
  frame element's `FRAME_ACTIVITY_EVENT`.
