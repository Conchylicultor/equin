# frame

The one framing primitive. **Every `<iframe>` in the app is one of its five
frames**, and `frame/no-raw-frame` (this plugin's `lint/`, `noDebt`) rejects a
raw `<iframe>`, `<frame>`, `<object>`, `<embed>`, a
`createElement("iframe")` or a `.srcdoc` / `.sandbox` write anywhere else.
`web/components/frames.tsx` is the one sanctioned file.

Why: untrusted active content must never run on an app origin. A frame on our
own origin — unsandboxed, or sandboxed with `allow-same-origin` (a no-op as a
boundary there) — IS the app: it sends the owner's credentials, so it is the
owner to every check of the HTTP edge, and it can reach `top`. Trust
boundaries, Phase 3 — design: [`research/2026-10-29-global-content-isolation.md`](../../../../../../research/2026-10-29-global-content-isolation.md).

| Frame | Takes | Sandbox | For |
|---|---|---|---|
| `ContentFrame` | a `ReadyContentUrl` (`useContentUrl(contentPath)`) | `allow-scripts allow-same-origin allow-forms allow-popups allow-modals` — on the content host's origin, never `top`'s | untrusted content: prototypes |
| `ForeignFrame` | a URL, classified by `classifyFrameUrl` | the third-party set (a player keeps its own storage) | a pasted embed |
| `InlineFrame` | an HTML string | opaque `srcdoc` — no `allow-same-origin`, ever | file-viewer HTML |
| `PdfFrame` | an `AssetPath` | none (the PDF viewer needs it) | file-viewer PDF |
| `AppFrame` | a namespace + an in-app path (never a URL) | none — it is the app | worktree preview, compare "Real app" |

`allow-same-origin` is spelled only for a URL the frame built (content) or
classified as another site (foreign).

## Content: the content host

A route serving untrusted content declares `access: { content: "<reason>",
item: "<param>" }` (`infra/endpoints`, a GET only). Then:

- the gateway serves it only on `http://<item>.content.localhost:<port>/<ns>/api/…`
  (`gateway/content.go`): one origin per piece of content (`<item>`, the
  route param's value — a prototype's id), the namespace in the path. Stamped
  principal `content`; nothing but `/api/` routes; no `/ws`, no Service Worker
  scripts; `frame-ancestors` the app origins, `CORP: same-origin`;
- the socket host serves it only to the `content` principal — an app-origin
  request answers `403 content-only`, anyone else `403 cross-site-refused`
  (`framework/principal`'s gate);
- its `text/html` answers get the **frame agent** injected as the first script
  of `<head>` (`injectFrameAgent`, run by `endpoints`' handler brand for every
  content route — no route can forget it).

The client side: `contentPath(endpoint, params)` (`endpoints/core`) → an
opaque `ContentPath` (its `item` taken from the declaration's param, never a
caller's choice) → `useContentUrl` / `contentUrlOver(transport, …)` → a
branded `ReadyContentUrl` on the transport's `content` serving → `ContentFrame`.
`Transport.content` (`primitives/networking`) is `content-host` for the page's
own server (derived from `location`; `null` on a host that is no namespace) and
`same-origin` — with its declared reason — for an in-browser server (repo
fixtures, through its frame Service Worker).

## The channel (`plugins/agent` — protocol and agent; `web/internal/channel.ts`)

The parent can no longer read the document, so it asks. On every `load`,
`ContentFrame` posts a `MessagePort` to the frame (target origin = exactly the
URL it framed) and hands `onChannel` a `FrameChannel`: `setVars`,
`setScreenHeight`, `dispatchResize`, `settle`, `measure`, `watchHeight` /
`unwatchHeight` (→ `height` events), `captureScroll` / `restoreScroll` /
`cancelRestore`; plus `activity` events, re-fired on the frame element as
`FRAME_ACTIVITY_EVENT` (bubbling) for whoever watches for the reader's input.

- **Every answer is untrusted data.** The agent shares a realm with the
  content, which can take the port and answer in its place. Replies are
  zod-parsed and bounded (`FRAME_REPLY_VALUES`); a message the protocol does
  not spell is ignored; nothing a reply says does more than lay a frame out.
- **Self-contained agent.** `installFrameAgent` is serialized with
  `toString()` into the content document, so it references nothing outside its
  body (the protocol id is passed in); `frame-agent.test.ts` holds it to that.
- A request unanswered in 10 s fails loudly (`FrameChannelError`, naming the
  likely cause: a document not served by a content route). One pending when
  its frame is replaced rejects with `FrameChannelClosedError` — an expected
  end a caller tells apart.

## Verification

`./equin run plugins/primitives/plugins/embed/plugins/frame/e2e/content-probe.ts`
mints a hostile prototype, opens it in this deploy's canvas and checks every
attack is denied from inside the content frame (top, owner API on both hosts,
sockets, scripting an app window, the app's storage, a Service Worker,
navigating the app), its own files and storage still work, the canvas reaches
it over the channel, a content route on the app origin is `403 content-only`;
the same reads from the app's own realm are the negative control. The gateway
must be the new one (`./equin start --force`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The one framing primitive — every <iframe> in the app is one of its five frames, and frame/no-raw-frame rejects one anywhere else. ContentFrame: untrusted content (an access: { content } route's document, an agent-written prototype) on the content host (<item>.content.localhost, one origin per piece of content, never an app origin), talked to over the frame agent's channel (FrameChannel: CSS vars, screen height, scroll capture/restore, heights, activity — every reply untrusted data). ForeignFrame: a pasted third-party URL, classified first (an equin page, the content host, this computer or a non-web scheme is refused). InlineFrame: an HTML string in an opaque srcdoc sandbox. PdfFrame: a served PDF asset. AppFrame: the app itself at an in-app path, on this origin or another namespace's.
- Web:
  - Uses:
    - `infra/endpoints.AssetSrc`
    - `infra/endpoints.ContentUrl`
    - `infra/endpoints.contentUrlOver`
    - `infra/endpoints.ReadyContentUrl`
    - `infra/endpoints.useAssetSrc`
    - `primitives/networking.useTransport`
  - Exports (types):
    - `FrameChannel`
    - `InlineFrameAllowance`
  - Exports (values):
    - `AppFrame`
    - `ContentFrame`
    - `ForeignFrame`
    - `FRAME_ACTIVITY_EVENT`
    - `FrameChannelClosedError`
    - `FrameChannelError`
    - `InlineFrame`
    - `PdfFrame`
    - `useContentUrl`
- Core:
  - Uses:
    - `infra/namespace.isContentHost`
    - `infra/namespace.namespaceFromHost`
  - Exports (types): `FrameUrlClass`
  - Exports (values): `classifyFrameUrl`
- Cross-plugin:
  - Imported by:
    - `apps/prototypes/canvas`
    - `apps/prototypes/compare/route`
    - `apps/prototypes/present`
    - `conversations/conversation-view/open-app`
    - `page/embed`
    - `page/prototype`
    - `primitives/file-viewer/html`
    - `primitives/file-viewer/pdf`
- Exemptions:
  - Exempts itself from:
    - `frame/no-raw-frame` — `web/components/frames.tsx` (sanctioned)
    - `namespace:no-hand-built-url` — `core/classify-url.ts` (sanctioned)
  - Exempted by: `primitives/embed/frame` (0 debt)
- Sub-plugins:
  - **`agent`** — The content-frame channel's protocol and its frame agent: the script injected into every content document, answering the parent's closed set of requests over a MessagePort.

<!-- AUTOGENERATED:END -->
