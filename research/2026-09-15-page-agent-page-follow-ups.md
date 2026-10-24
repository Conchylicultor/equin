# Agent pages, follow-ups: a header toggle, and agents renaming their pages

Follows [`2026-09-11-page-agent-pages.md`](./2026-09-11-page-agent-pages.md).

## Context

The user asked three things after using agent pages:

1. **"It's not instantly clear whether a page is an agent one. Where is it indicated?"**
   Today, only from outside the page: the blue row in the parent page (with the
   creator chip), and the blue row in the Pages sidebar. The open page itself shows
   nothing.
2. **"There should be a way to toggle a page between agent and non-agent, like a
   toggle in the page toolbar."** There is none. Worse, the server refuses it: every
   data write goes through `rewriteBlockData`, which returns 409 when a page's
   `author` changes ("authorship is fixed when the block is created").
3. **"Can agents edit the title?"** No. An agent sets the title only when it mints the
   page (`<agent-page title="…">`). Afterwards `edit_page` refuses a changed `# Title`
   line, and the `title` on the `<agent-page id title/>` pointer is ignored.

User decisions (2026-09-15):

| Question | Decision |
|---|---|
| How the open page shows it is an agent page | **The toolbar toggle only.** No banner, no chip on the open page. The toggle is blue and pressed on an agent page. |
| How an agent renames its page | **Edit the `# Title` line with `edit_page`.** No new tool. |

## What the user sees

- In the open page's header strip (star, history, …, copy ID), a new ✨ button.
  - On an agent page it is blue and pressed. Tooltip: "Agent page: agents can write
    all of it. Click to make it a normal page."
  - On any other page it is a plain ghost icon. Tooltip: "Make this an agent page:
    agents will be able to write all of it."
  - One click flips it. The parent row's tint and chip, and the sidebar tint, follow
    live.
- An agent reading the page with `read_page` sees `# Findings` as the first line. On
  an agent page, `edit_page` changing that line to `# Final findings` renames the page.
  On a human's page the same edit is still refused.

## 1. Server: the toggle as its own operation (`page/editor`)

The author stays impossible to change **through a data edit**. It changes only
through one new operation, which changes nothing else.

- **`core/endpoints.ts`**: `setPageAuthor`, `POST /api/blocks/:id/page-author`, body
  `{ author: "agent" | "human" }` (the existing `BlockAuthor` type), response
  `BlockSchema`. Declared beside `turnIntoPage`.
- **`server/internal/parse-block-data.ts`**: `reauthorPageData({ before, author })`, the
  second and only other minter of the `BlockDataRewrite` brand. It copies the stored
  data verbatim, sets `author: "agent"` or removes the key, and validates the result
  with `parseBlockData("page", …)`. So an author change cannot carry any other edit,
  and a data edit still cannot carry an author change. Rewrite the `rewriteBlockData`
  comment: "fixed when created" becomes "changed only by `reauthorPageData`".
- **`server/internal/handle-set-page-author.ts`**, shaped like `handle-update-block.ts`:
  - Read `{ type, pageId }` before the lock. 404 if gone. 400 if the row is not a page.
  - `withPageForest(existing.pageId, …)`. That is the scope the page row lives in, the
    same one the header's title edit locks.
  - Re-read the row under the lock. If it already has that author, return it with no
    write.
  - Otherwise `updateBlockFields(ctx.tx, id, { data: reauthorPageData(…), updatedAt })`.
  - After commit, `notifyBlockChange(…)`. That event already refreshes the parent's
    row and the sidebar.
  - Register it in `server/index.ts` `httpRoutes`.
- **Any page can be toggled**, including a top-level page. It is the human's choice.
  No MCP tool exposes this operation, so only the human flips it.
- **History restore keeps the current author.** `restorePageContent`
  (`page-content.ts`) now 409s when a version's `author` differs from the row's, which
  the toggle makes reachable. From now on, a version restores the page's content,
  title, icon and cover, but never its kind, the same way it never moves the page.
  Build `next` as the snapshot's page data with the stored row's `author` carried
  over, then pass it through `rewriteBlockData` as today.

What does not change: `turnIntoPage`'s `author` (the `/agent-page` path), and the
authorship table. Flipping an agent page to human keeps its authorship rows. The
chip just stops showing (the decoration applies only to agent pages), and comes back
if the page is flipped back.

## 2. Web: the toggle button (new plugin `apps/pages/plugins/page-author`)

A sibling of `copy-id` and `starred`, web only. It lives under `apps/pages` because
`PageDetail.HeaderActions` is Pages-app chrome, and no `plugins/page/**` plugin
imports an `apps/**` web barrel. It is named `page-author` because "agent page" is
already taken by `apps/pages/agent-origin`.

- `web/index.ts`: `PageDetail.HeaderActions({ id: "page-author", component: PageAuthorToggle })`.
- `web/components/page-author-toggle.tsx`:
  - Reads `useResource(pagesResource)`, finds the row, reads `pageData(row).author`.
  - While the resource is pending it renders an icon-sized `Loading`, never an
    "off" button, which would claim a fact not yet known. If the page is not found
    it renders nothing.
  - An `IconButton` with `MdAutoAwesome` (the same icon as `/agent-page`),
    `aria-pressed`, and `text-info bg-info/10` when pressed. The label and tooltip
    follow the state, as above.
  - `onClick` calls `useEndpointMutation(setPageAuthor)` with the opposite author, in
    the same way as `useStar`. The button waits for the server, and the icon flips when the
    live `pagesResource` push lands.
- `config/apps/pages/page-tree/header-actions.jsonc`: place
  `apps.pages.page-author:page-author` after history and before copy ID. Copy ID
  stays last as the utility. `./equin build` re-stamps the origin hash.
- The plugin's `CLAUDE.md`: what the button shows, and why it is not in the
  `agent-page` plugin (the layering above).

No banner or other open-page indicator, per the user's decision.

## 3. Agents rename by editing the `# Title` line (`agent-access` + `markdown-apply`)

The banner stays a line the reader adds on top. It never becomes a block, and
`markdown-apply` is not changed. `edit_page` pulls the new title out of the edited
document, gives the apply the stored banner back, and writes the title separately
through the page row's data. That is the path `agent-access/CLAUDE.md`'s stated bound
asks for: "A later rename feature should write the page row's `data`, not relax
this."

- **`markdown-apply/core/page-title.ts`**: `parsePageTitleBanner(line, ctx)`, the
  inverse of `bannerLine`, next to the other two halves. It returns `{ ok: true, title }`
  or `{ ok: false, reason }`.
  - The line must be `# ` plus inline markdown whose runs carry no marks (a title is
    plain text). The title is the plain text of those runs.
  - It must round-trip: `bannerLine(title)` must equal the line byte for byte, or it
    is refused. That rules out a title the stored form cannot hold.
- **`agent-access/server/internal/mcp-tools.ts`, `edit_page`**. For a page-rooted edit
  whose first line changed, which is today's 400:
  - **If the page is agent-authored** (`blockAuthorOf(pageBlockHandle, scope.pageRow.data)`),
    and the new document's first non-empty line parses with `parsePageTitleBanner`,
    followed by a blank line or the end of the document, then this is a rename.
    - Replace that line in `next` with the stored banner. The result must be
      byte-identical to the read: **a rename changes the title line and nothing
      else** (added during implementation). Without this, deleting the banner of a
      page whose first block is an H1 reads as "rename to that heading and delete
      it". A rename plus a content change is two calls.
    - The content apply then plans nothing.
    - Call `renamePage(pageId, title, { requireAuthor: "agent" })`, the call's only
      write.
    - Stamp the page's authorship with this conversation, and report
      `renamed_to: "<title>"` in the result.
  - **Otherwise** (a human's page, a deleted line, or a mangled line or a line with marks),
    return the existing 400. On an agent page it gains a hint: change the text after
    `# ` to rename the page, and keep it on one line.
- **`page/editor/server`: `renamePage(pageId, title, { requireAuthor? })`**, exported
  from the barrel. It locks the page row's scope, re-reads the row, and throws 409 if
  `requireAuthor` no longer matches under the lock (a human flipped the page in the
  meantime). It writes `{ ...stored, title }` through `rewriteBlockData` (the author
  is unchanged, so the check passes), then `notifyBlockChange`. The author check sits
  under the lock because checking only in the tool would leave a race.
- **Unchanged**:
  - `write_agent_note`: a byte-identical banner is dropped, and any other `# …` line
    is a heading. A rename there cannot be told apart from a first heading, which is
    why the rename is `edit_page` only.
  - The pointer's `title` in the parent page stays read-only and ignored.
- **Tool descriptions**: `edit_page` says that on an agent page the `# Title` line is
  the page's title and editing it renames the page, and that on any other page it is
  read-only. `write_agent_note` points to `edit_page` for renames.

## 4. Docs

- `agent-page/CLAUDE.md`: the author is set at birth by `/agent-page` or a mint, and
  changed afterwards only by the header toggle (`setPageAuthor`). Also that agents rename
  through the `# Title` line.
- `agent-access/CLAUDE.md`: replace the stated bound "The `# Title` banner is not
  writable" with the rename rule, and the reason it is `edit_page` only.
- `page/editor/CLAUDE.md` and the `annotations/CLAUDE.md` write-rule section: the page's
  author is changed only by `reauthorPageData`, and restore keeps it.
- `apps/pages/plugins/page-author/CLAUDE.md` (new).

## Stated bounds

- **A rename is its own `edit_page` call.** Renaming and changing content in one
  edit is refused. If a human flips the page to human after the agent read it,
  the rename is refused with a 409 and nothing is written.
- **A title edit racing a toggle.** The header's title, icon and cover writes send
  `{...pageData(page), …}` from the live resource. A save built just before a toggle's
  push lands carries the old author and gets 409. The window is a few milliseconds
  after a click on the button.
- **A stale agent document.** An agent whose baseline still holds
  `<agent-page id="X"/>` after X was flipped to human is refused (`unknown-ref`) by the
  planner's canonical-pointer check. That is the correct answer.
- **Human to agent hands over the human's existing prose.** Every block on the page
  becomes writable by agents, except `<human>` / `<todo>` cards, which still refuse
  under the nearest-declaration rule. The tooltip says so.

## Order

1. editor: `reauthorPageData`, `setPageAuthor`, `renamePage`, restore carrying the
   author.
2. markdown-apply: `parsePageTitleBanner`.
3. agent-access: the `edit_page` rename branch and the descriptions.
4. web: the `page-author` plugin and the header config.
5. docs.

## Verification

- **Unit tests** via `./equin test <plugin>`:
  - `editor/server/internal/parse-block-data.test.ts`: `reauthorPageData` flips both
    ways, carries every other key verbatim, and refuses a non-page row.
    `rewriteBlockData` still refuses a flip.
  - `editor/server/internal/page-content.test.ts`: restoring a version taken before a
    flip succeeds and keeps the current author.
  - `markdown-apply/core/page-title.test.ts`: `parsePageTitleBanner` round-trips
    plain titles, including escaped characters and an empty title. It refuses marks,
    a non-`#` line and an `##` line.
  - Editor server DB tests, in the style of `handle-patch-blocks.test.ts`:
    `setPageAuthor` is a no-op on the same author, and one event per flip.
    `renamePage` with `requireAuthor` refuses a human page.
- **`./equin check`**: type-check, plugin boundaries, docs and config origins in
  sync.
- **E2E**: extend `agent-access/e2e/agent-access-verify.ts`:
  - mint an agent page, then rename it with `edit_page` on the `# Title` line. The
    stored title changes and the result says `renamed_to`.
  - the same edit on a human page is refused.
  - flip the page to human with `setPageAuthor`. A rename is now refused and so is a body write.
  - flip it back. Writes are accepted again.
- **UI**: after `./equin build`, run `screenshot.ts --path /pages/page/<agent-page-id>`
  with `--click` on the toggle. Check that the button is blue and pressed before the
  click, plain after it, and that the parent row's tint is gone after reload. Repeat
  in dark mode.
