# Page editor: media blocks (file, video, audio, embed, bookmark)

## Context

The Pages block editor (`plugins/page/`) supports text-family blocks, code, divider,
page links — and **image** (the only attachment-owning block). It has **no** way to:

- attach an arbitrary **file** (download card),
- embed a **video** or **audio** file,
- embed an external **URL** (YouTube/Vimeo/etc. via `<iframe>`),
- drop a **link bookmark** (a rich preview card: title, description, site, favicon, og:image).

This plan adds those five block types. The work also forces one clean structural
refactor (below), because the attachment-link table name is derived from the owner
table and **image already owns it**.

### The forcing constraint

`Attachments.defineLink(_blocks)` (`plugins/infra/plugins/attachments/server/internal/define-link.ts:55`)
derives the join-table name from the owner table → `page_blocks_attachments`. The
image plugin already calls this (`plugins/page/plugins/image/server/internal/tables.ts:6`).
A second `defineLink(_blocks)` for file/video/audio would collide on that name.

→ There must be **one** block↔attachment link for *all* page block types, plus **one**
generic reconcile job — and image must migrate onto it. This is a forced, clean
de-duplication, not optional polish. After it, adding an attachment-owning block needs
**zero server code**.

### Decisions (confirmed with user)

- **Bookmark images:** cache as attachments (server downloads og:image + favicon once,
  stores via the attachments primitive, served same-origin). Private + offline-capable.
- **Video/audio source:** uploaded files only. External providers are the embed block's job.
- **Paste-to-embed:** included now — pasting a bare URL into an empty text block offers
  Bookmark / Embed / Plain link.

## Architecture

All new blocks plug into the existing `Editor.Block` dispatch slot via `defineBlock` +
one web contribution — the established recipe (see `plugins/page/plugins/image`). New
flat sub-plugins under `plugins/page/plugins/` (matches the existing flat block layout;
image is **not** moved, to avoid plugin-id churn).

### 1. Shared infra: `page/plugins/attachment-block` (NEW)

The single home for everything attachment-owning blocks share.

- **core/** — `collectBlockAttachmentIds(data): string[]` — the *convention*: a block's
  managed attachments live in `data.attachmentId` (string) and/or `data.attachmentIds`
  (string[]). Returns the union. This is the contract every attachment block follows;
  document it in the plugin's `CLAUDE.md`.
- **server/** — owns the single `Attachments.defineLink(_blocks)` →
  `page_blocks_attachments` (moved here from image). Owns **one** generic reconcile:
  scan all blocks for a page, link every id from `collectBlockAttachmentIds(block.data)`,
  clear the rest — bound to the `blocksChanged` trigger. This replaces image's
  `reconcile.ts` / `reconcile-job.ts` / `tables.ts` / server `index.ts` wiring.
- **web/** — `<AttachmentUpload accept label icon onUploaded uploading error … />`: the
  empty-state click/drop/paste funnel extracted from `EmptyImageBlock`
  (`plugins/page/plugins/image/web/components/image-block.tsx:69-154`), `accept`-driven.
  Used by image, file, video, audio. Filled states stay per-block.

**Image migration:** image keeps `imageBlock` (core), `ImageBlock`/`FilledImageBlock`
(web) and its `data.attachmentId` shape unchanged. It drops its entire `server/` plus
its bespoke empty state, reusing `<AttachmentUpload accept="image/*">` and the shared
reconcile. Net behavior identical; less code.

### 2. `page/plugins/file` (NEW)

- core: `defineBlock({ type:"file", schema:{ attachmentId?, filename?, mime?, size? }, label:"File", icon: MdAttachFile, aliases:["attachment","upload","document","pdf"] })`.
- web: empty → `<AttachmentUpload accept="*">`; filled → a download card (mime icon,
  filename, humanized size, `<a href={attachmentUrl(id)} download>`), built from
  `Card`/`Row`/`Text`/`Stack` primitives. Reuse `attachmentUrl` from
  `primitives/text-editor/paste-images/web`.
- No server (shared reconcile handles it via `data.attachmentId`).

### 3. `page/plugins/video` + 4. `page/plugins/audio` (NEW)

- core: `defineBlock` with `{ attachmentId?, filename?, mime? }`, labels Video/Audio,
  icons `MdVideoLibrary` / `MdAudiotrack`, aliases (mp4/movie / sound/mp3…).
- web: empty → `<AttachmentUpload accept="video/*" | "audio/*">`; filled → native
  `<video controls>` (rounded, `max-w-full`) / `<audio controls className="w-full">`.
- No server.

### 5. `page/plugins/embed` (NEW)

- core: `defineBlock({ type:"embed", schema:{ url? }, label:"Embed", icon: MdCode, aliases:["iframe","youtube","video url","tweet"] })`
  + `providers.ts`: `toEmbedUrl(raw)` mapping known hosts (YouTube `watch?v=`/`youtu.be`,
  Vimeo, Spotify, …) to their embed URL, generic fallback = the raw URL.
- web: empty → a URL input row (paste/type a URL → `editor.update({ url })`); filled →
  responsive 16:9 container with a **sandboxed** `<iframe sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" allowfullscreen>`.
  Small "open original" affordance for sites that refuse framing (X-Frame-Options can't
  be detected reliably — note in code).
- No DB/server.

### 6. `page/plugins/bookmark` (NEW) + metadata endpoint

- core: `defineBlock({ type:"bookmark", schema:{ url?, title?, description?, siteName?, imageId?, faviconId? }, label:"Bookmark", icon: MdBookmark, aliases:["link","preview","card"] })`.
  **Maps og:image + favicon into the shared convention** by also exposing them through
  `data.attachmentIds = [imageId, faviconId].filter(Boolean)` so the generic reconcile
  links them (avoids orphan sweep). (Store `imageId`/`faviconId` for rendering *and* mirror
  into `attachmentIds`; or have `collectBlockAttachmentIds` read named fields — pick one
  consistent shape during impl; `attachmentIds` array is the simplest.)
- core/endpoints: `GET /api/link-preview?url=…` → `{ title?, description?, siteName?, imageId?, faviconId? }`
  via `defineEndpoint` (`plugins/infra/plugins/endpoints`).
- server: `implement(linkPreview, …)`:
  1. Validate scheme is `http(s)` and host is **not** loopback/private-range (basic SSRF
     guard — fail loud with `HttpError`). 
  2. `fetch` the page; parse with Bun's built-in **`HTMLRewriter`** (no new dep) for
     `og:title`/`twitter:title`/`<title>`, `og:description`/`meta description`,
     `og:site_name`, `og:image`/`twitter:image`, `<link rel="icon">` (resolve relative
     URLs against the page; fall back to `/favicon.ico`).
  3. Download og:image + favicon (best-effort; degrade gracefully if missing/oversized),
     `createAttachment(bytes, name, mime)` (`attachments/server`), return their ids.
  Use a fetch timeout + size cap; surface unexpected network failure to the client
  (block shows an error state — not silently empty).
- web: empty → URL input; on submit call `useEndpoint`/`fetchEndpoint(linkPreview)`,
  then `editor.update({ url, …meta, attachmentIds })`. Filled → a horizontal preview
  card (favicon + site, title, description, thumbnail via `attachmentUrl(imageId)`),
  clickable to open the URL in a new tab. Loading + error states.

### 7. Paste-to-embed (touches the editor's extension API — minimal, additive)

The block-text extension interface (`plugins/page/plugins/editor/web/internal/block-text-extensions.ts:32`)
is **node-centric**: `node`/`deserializePattern`/`createNodeFromMatch`/`serializeNode`
are required. Paste-to-embed needs only the optional `Plugin` (a Lexical paste handler),
no inline node.

- **Clean generalization (additive):** make the node-related fields **optional** on
  `BlockTextExtension`, and guard `blockTextNodes()`, `appendLineNodes()`,
  `serializeBlockText()` to skip extensions that don't contribute a node. This is a
  strict superset of today's behavior (every existing extension still works) and removes
  a real footgun (a behavior-only extension shouldn't be forced to fake a node). Confined
  to the page editor plugin.
- **New `page/plugins/url-paste`** contributes a `Plugin`-only block-text extension: on
  `PASTE_COMMAND`, if the block is empty (or fully selected) and the clipboard is a single
  bare URL, `preventDefault` and show a small inline menu — **Bookmark** / **Embed** /
  **Plain link**. Bookmark/Embed call `editor.convertTo(bookmarkBlock.type | embedBlock.type, { url })`;
  Plain link inserts the URL as text (default). References the two block `type` constants
  from their core barrels.

## Files

**New plugins** (each: `package.json`, `core/index.ts`, `web/index.ts`, and `server/index.ts` where noted):
- `plugins/page/plugins/attachment-block/{core,web,server}` — shared link + reconcile + `<AttachmentUpload>` + `collectBlockAttachmentIds`.
- `plugins/page/plugins/file/{core,web}`
- `plugins/page/plugins/video/{core,web}`
- `plugins/page/plugins/audio/{core,web}`
- `plugins/page/plugins/embed/{core,web}` (+ `core/providers.ts`)
- `plugins/page/plugins/bookmark/{core,web,server}` (+ `core/endpoints.ts`, server scraper)
- `plugins/page/plugins/url-paste/{core,web}`

**Modified:**
- `plugins/page/plugins/image/` — delete `server/` (link+reconcile move to attachment-block);
  refactor `web/components/image-block.tsx` empty state onto `<AttachmentUpload>`.
- `plugins/page/plugins/editor/web/internal/block-text-extensions.ts` — node fields optional + guards.
- `plugins/page/plugins/editor/web/index.ts` — re-export `BlockTextExtension` change is type-only (no API removal).
- Each plugin's `CLAUDE.md` + the page `CLAUDE.md` reference block (regenerated by `./equin build`).

**Reused (no change):** `defineBlock` (`page/editor/core`), `Editor.Block`
(`page/editor/web/slots.ts`), `uploadAttachment` (`attachments/web`), `createAttachment`
(`attachments/server`), `attachmentUrl` (`text-editor/paste-images`), `defineEndpoint`/
`implement`/`useEndpoint` (`infra/endpoints`), `Card`/`Row`/`Text`/`Stack`/`Surface`
primitives, `blocksChanged` trigger (`page/editor/server`).

## Migrations

- New `page_blocks_attachments` now declared in `attachment-block/server` instead of
  `image/server`. Same table name + shape → **no DDL change** expected, but confirm
  `./equin check migrations-in-sync` reports no new migration after the move (the
  drizzle schema glob picks the table up from its new file). Embed/video/audio/file add
  **no tables**. Bookmark adds **no tables** (uses shared link). `./equin build`
  regenerates any migration; commit it if one appears.

## Verification

1. `./equin build` → resolve type-check / boundary / migrations-in-sync / doc-in-sync.
2. Open `http://att-1781558705-fopm.localhost:9000`, go to Pages, create a page.
3. For each new type via slash menu / `+`: insert, then
   - file/video/audio/image: upload via click, drop, **and** paste; confirm filled render,
     download (file), playback (video/audio), resize (image still works).
   - embed: paste a YouTube + a Vimeo URL → iframe renders.
   - bookmark: paste a real article URL → card with title/description/favicon/thumbnail.
4. **Reconcile / orphan correctness:** via `mcp__singularity__query_db`, confirm
   `SELECT * FROM page_blocks_attachments` has one row per uploaded media and the two
   bookmark image rows; delete a block and confirm its rows disappear (FK cascade), and a
   converted-away block clears its rows (reconcile).
5. **Paste-to-embed:** in an empty text block paste a bare URL → menu appears; choose
   Bookmark → block converts to a populated bookmark; Embed → iframe; Plain link → text.
6. Scripted check with `e2e/screenshot.mjs` for at least the bookmark + embed happy paths.
7. Re-run `./equin check` clean.

## Risks / tradeoffs

- **SSRF:** the link-preview endpoint fetches user URLs server-side. Mitigated by
  scheme + private-IP guards and timeout/size caps; full hardening (DNS-rebinding, redirect
  re-validation) noted as a possible follow-up.
- **Iframe framing refusals:** some sites send X-Frame-Options/CSP and won't embed; we
  can't detect this reliably client-side, so the embed block always offers an "open
  original" link.
- **Editor extension API change** is additive (node fields optional) and confined to the
  page editor; every existing extension keeps working.
- **Image migration** changes which file declares `page_blocks_attachments`; behavior is
  identical and verified via the reconcile test above.
