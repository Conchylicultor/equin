# Page links: pasted URLs become links, a hover card, and Mention

## Context

The user asked for four things in the Pages editor, all modelled on Notion:

1. A URL you paste should be a real, clickable link.
2. Hovering a link shows a small card under it: globe icon + URL, **Copy**, **Edit**.
3. Pasting a URL shows the URL in the text right away, with the choice menu next
   to it. Today the paste is swallowed and only the menu appears. **Cmd/Ctrl+Z
   while that menu is open closes the menu and removes the pasted text.** It must
   not undo the edit before the paste.
4. The menu gains a **Mention** option. It fetches the page's title and shows the
   link with the title as its text. **Decided with the user: a mention is an
   ordinary link whose text is the title.** It is not a chip, and it gets the same
   hover card.

### What the code does today

- `page/url-paste` (`web/components/url-paste-plugin.tsx`) only acts on a bare
  URL pasted or dropped into an EMPTY block. It cancels the paste and opens a
  3-row caret menu: Bookmark / Embed / Plain link. "Plain link" inserts the URL
  as **plain text**, not a link. Its empty-block check reads `textOf(block)`,
  the row copy of the text, which can be up to ~1 s behind what is on screen.
- A URL pasted into a block that already has text is left to Lexical's default,
  which inserts **plain text**.
- Links are already clickable. `@lexical/link@0.44.0`'s `registerClickableLink`
  (`LexicalLink.dev.mjs:847-907`) opens the link on a **plain** click when the
  caret is collapsed. The comment in `editor/web/components/block-text-editor.tsx`
  above `<ClickableLinkPlugin newTab />` says a plain click places the caret. That
  comment is wrong.
- `LinkPlugin` already wraps a **selected range** in a link when a URL is pasted
  over it (`LexicalLink.dev.mjs:778-800`). We leave that path alone.
- A link is already a first-class part of the text model (`TextRun.link`). It
  round-trips through the content doc, markdown `[text](url)`, the server text
  writer and the read-only view (`<a target=_blank>`). A title-text mention
  therefore needs **no new node type and no server change** to be stored.

## Design

### 1. Paste → link + menu (`page/url-paste`, rewritten)

**The gate.** A single bare http(s) URL, pasted at a **collapsed** caret, in
**any** text block. A non-collapsed selection is declined, because `LinkPlugin`
wraps it. Drop keeps today's gate (an empty block only), because a drop into
existing text has no caret we control.

**The insert is its own undo step.** Cancel the paste, then call
`useBlockEditor().recordDocEdit(block.id, "Paste link", edit)`. `edit` runs
`lexical.update(..., { discrete: true })`, which:

- inserts a `$createLinkNode(url)` holding a text node `url`;
- puts the caret after the link (`LinkNode.canInsertTextAfter()` is false, so
  typing continues outside the link);
- snapshots the root's text content and opens the menu.

`recordDocEdit` already exists for exactly this. It runs the edit one microtask
later (we are inside the paste command's `editor.update`), ends the open typing
run first, and records the paste as ONE entry
(`editor/web/block-editor-context.tsx:1134`). Today it is used by inline-markdown
and mark-boundary.

**Menu lifetime.** The menu stays open until one of these happens:

- a row is picked;
- Esc, or a click outside (`useCaretMenu`'s existing handling);
- focus leaves the editor (`useForcedCaretQuery`);
- **the block's text changes after the insert** — anything at all: typing,
  Backspace, undo, a remote edit.

The last rule is a `registerUpdateListener` that compares the root's text with
the snapshot. It is the entire Cmd+Z story, with no key interception:

- Cmd+Z reaches the surface undo stack as usual.
- The paste was its own entry, and `usePendingFlush` ends any open run first, so
  the entry popped is the paste.
- Replaying it removes the link. The text changes. The menu closes.

The same rule matches Notion's "keep typing and the menu goes away".

**Menu rows**, in commit-index order:

| row | when shown | commit |
| --- | --- | --- |
| Keep as link | always | close the menu (the link is already in place) |
| Mention | `serverSync` only (the memory-mode demo has no server to fetch from) | see §2 |
| Create bookmark | the block held nothing but the pasted link | `editor.convertTo(BOOKMARK_TYPE, { url })` |
| Create embed | same | `editor.convertTo(EMBED_TYPE, { url })` |

Bookmark and Embed convert the block without stripping the link from its
content doc. That is what Turn-into already does to a non-empty block. It also
means undoing the conversion brings back the pasted link, and a second undo
removes the paste. That matches Notion.

The "was empty" test reads the **live** root text inside the paste handler, not
the lagging `textOf(block)`.

### 2. Mention (`page/url-paste` + a light endpoint in `page/bookmark`)

- **Server.** Split `bookmark/server/internal/scrape.ts` into two functions:
  - `scrapeLinkMeta(url)`: the existing SSRF-guarded fetch and HTMLRewriter parse.
    It **does not download images**.
  - `scrapeLinkPreview`: `scrapeLinkMeta` plus the og:image and favicon caching,
    as today.

  Add `linkMetaEndpoint` (`GET /api/link-meta?url=` → `{ title?: string }`) in
  `bookmark/core/endpoints.ts`, implemented beside `handle-link-preview.ts`. We do
  not reuse `/api/link-preview`: every call to it creates two orphan attachments.
- **Client.** Picking Mention closes the menu and fetches the title. The link
  shows its URL in the meantime, which is its true current state. When the title
  arrives, and the link node (by key) still exists with the same URL and the URL
  as its text, `recordDocEdit(block.id, "Mention link", …)` replaces its text with
  the title. If the user changed the link meanwhile, we skip; that is their edit
  winning, not an error.
- **Failure.** An `EndpointError` (SSRF 400, upstream 502), or a page with no
  title, shows a toast (`showToast`) and leaves the URL as it is. Anything else is
  rethrown.
- **Undo.** Cmd+Z after a mention restores the URL text. A second Cmd+Z removes
  the paste.

### 3. Link hover card (`page/formatting/link`)

`formatting/link` already owns link editing (the ⌘K / toolbar popover). It gains:

- **`LinkHoverPlugin`**, registered as a Plugin-only block-text extension via a
  side-effect `web/internal/register.ts`, the same shape as url-paste.
  - It gets `{ block }` and the Lexical editor, and attaches `pointerover` /
    `pointerout` to the editor root (`registerRootListener`) to track the hovered
    `<a>`.
  - **Hover intent.** Open after ~300 ms on a link. Close ~200 ms after the pointer
    leaves both the link and the card. Entering the card cancels the close, so the
    pointer can travel from the link to the card. Never open while a mouse button
    is held (drag-selecting).
- **The card** renders in `FloatingSurface`
  (`primitives/overlay/floating-surface`), which never takes focus: anchored to
  the `<a>` element, `side="bottom" align="start"`, with flip and scroll-follow
  built in.
  - **View mode:** globe icon + URL (truncated; click opens it in a new tab),
    `CopyButton text={url}`, and an **Edit** button.
  - **Edit mode:** a form with **URL** and **Title** fields, **Remove link**, and
    Enter to apply.
    - The inputs carry `localUndoProps`, so Cmd+Z stays inside the field.
    - Esc or a click outside closes the card. In edit mode, moving the pointer
      away does not.
- **Writes** go through `recordDocEdit(block.id, …)` and look the node up by its
  key, so each edit is one undo step:
  - **Apply:** `setURL(normalizeLinkUrl(url))`. The link's children are replaced
    by one text node only when the title actually changed, keeping the first
    child's format.
  - **Remove:** move the link's children up into its parent, then remove the
    link node.
- **Shared form.** Extract the URL form from `link-button.tsx` into one
  `LinkForm` component, used by both the toolbar popover (URL only) and the hover
  card (URL + Title). That way the validation and the Apply/Remove behaviour
  exist once.

A mention is a `LinkNode`, so it gets this card with nothing extra.

### 4. Small fixes riding along

- Correct the stale `ClickableLinkPlugin` comment in `block-text-editor.tsx`
  (a plain click opens the link).
- Update the `PASTE_COMMAND` chain notes: the comment in `block-text-editor.tsx`
  and the table in `editor/CLAUDE.md` ("a bare URL into an EMPTY block" becomes
  "a bare URL at a collapsed caret"). The editor CLAUDE.md "transfer door" bullet
  gets the same change. The ordering argument still holds, because a token id
  inside a URL path matches nothing (`inlineBoundary`'s `(?<!\/)`).
- Add a short prose section to `url-paste/CLAUDE.md` stating the menu-lifetime
  rule ("closes on any text change"), since the Cmd+Z behaviour depends on it.
- Update the plugin descriptions of `url-paste`, `formatting/link` and `bookmark`.
  `./equin build` regenerates the docs.

## Files

- `plugins/page/plugins/url-paste/web/components/url-paste-plugin.tsx`: rewrite
  of the gate, the insert, the menu lifetime, the rows and the mention flow.
  - `package.json` gains `@lexical/link`.
- `plugins/page/plugins/bookmark/server/internal/scrape.ts`: split the scraper.
  - New `server/internal/handle-link-meta.ts`.
  - `core/endpoints.ts` + `core/schemas.ts` + `core/index.ts`: `linkMetaEndpoint`,
    `LinkMetaSchema`.
  - `server/index.ts`: register the route.
- `plugins/page/plugins/formatting/plugins/link/web/`: new
  `components/link-hover-plugin.tsx`, `components/link-hover-card.tsx`,
  `components/link-form.tsx`, `internal/register.ts`.
  - `link-button.tsx` switches to `LinkForm`.
  - `index.ts` imports `./internal/register`.
- `plugins/page/plugins/editor/web/components/block-text-editor.tsx`: comments
  only.
- `plugins/page/plugins/editor/CLAUDE.md`, `plugins/page/plugins/url-paste/CLAUDE.md`:
  prose.

What we reuse: `recordDocEdit` / `useBlockEditor`, `readTransferText`,
`normalizeLinkUrl` / `isValidLinkUrl` (all `page/editor/web`);
`useForcedCaretQuery` / `useCaretMenu` / `CaretTriggerMenu`; `FloatingSurface`;
`CopyButton`; `IconButton`; `showToast`; `fetchEndpoint` / `EndpointError`;
`localUndoProps`.

## Out of scope

- Turning URLs into links as you **type** them, or links for URLs already stored
  as plain text. Lexical transforms only run on edited nodes and are skipped for
  remote applies, so this needs its own design.
- A "Mention" action on an existing link in the hover card.
- A hover card on read-only surfaces. They already render clickable `<a>`s.

## Verification

1. `./equin build` (in the background), then `./equin check`
   (type-check, eslint, plugin boundaries, docs in sync).
2. Update `url-paste/e2e/url-paste-keyboard.ts` for the new row order.
3. Add `url-paste/e2e/url-paste-link-verify.ts`. On a scratch page it deletes
   afterwards, it checks:
   - a URL pasted into an empty block shows an `<a href>` **and** the menu at once;
   - Cmd+Z with the menu open leaves the menu closed and the block empty, and the
     text typed before the paste is still there;
   - typing after the paste closes the menu and keeps the link;
   - a URL pasted mid-sentence becomes a link;
   - Mention on `https://example.com` turns the link text into "Example Domain"
     with the href unchanged, and Cmd+Z brings the URL text back;
   - Bookmark and Embed still convert.
4. Add `formatting/plugins/link/e2e/link-hover-verify.ts`. It checks:
   - hovering a link shows the card with the URL;
   - Copy puts the URL on the clipboard;
   - Edit → new URL + title updates the `href` and the text, and one Cmd+Z reverts
     it;
   - Remove link leaves plain text;
   - moving the pointer from the link onto the card keeps it open.
5. Screenshot the card and the menu in light and dark with `screenshot.ts`, and
   compare against the user's Notion screenshot.
