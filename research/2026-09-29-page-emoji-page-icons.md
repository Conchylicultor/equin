# Emoji page icons, auto-generated from content

## Context

Page icons are Material Symbols names (`PageDataSchema.icon: SavedSymbolName`) that
almost nobody sets. The sidebar is a wall of identical document glyphs (2 of 20 pages
have an icon). The user wants every page to carry an **emoji**, picked by Haiku from
the page's title + content, so the tree is scannable at a glance.

An experiment on the 20 pages of the user's tree (`claude --print --model haiku`)
showed Haiku picks well from **title + first ~1500 chars**. Content fixes ambiguous titles:
"Current tracks" becomes 🚧, not 🎵. Siblings collide, though (Roadmap / Maps app both 🗺️;
Chords training / Chord song player both 🎸), so the prompt must see sibling icons.
A mockup is `proto-1790695854-vdde`.

Decisions taken with the user:

- **Emoji everywhere.** Page icons become emoji-only. Every existing page, including ones
  with a symbol icon, gets a generated emoji in a one-shot backfill.
- **Picker:** the page icon picker becomes an emoji picker.
- **Generate once**, then stable. A **Regenerate** action in the picker re-runs it on demand.
- **Placeholder:** a page with no icon yet keeps today's document glyph (no new state).

## Design

### 1. Emoji as a value: `ui/icons/plugins/emoji` (new)

A sibling of `saved-names`, with the same shape: a parsed, branded value.

- `core`:
  - `EmojiSchema`: `z.string().refine(isEmoji).brand<"Emoji">()`.
  - `isEmoji(s)`: exactly one grapheme (`Intl.Segmenter`) matching `/^\p{RGI_Emoji}$/v`.
    Both Bun (JSC) and the browser support the `v` flag.
  - `type Emoji`.
- `web`:
  - `<EmojiPicker onSelect>` wraps **frimousse**, a small headless React emoji picker.
    It is the one new dependency.
  - Its emojibase data is served same-origin through `infra/asset-mirror`
    (`defineAssetMirror`, passed as frimousse's `emojibaseUrl`). No CDN at runtime, and it
    works offline after warm-up.

### 2. `PageDataSchema.icon` becomes `EmojiSchema.nullable()`

This is a narrowing, so it is inexpressible to store a symbol on a page afterwards.
All call sites follow from tsc.

- **Data migration** (custom SQL, `./equin build --custom-migration --migration-name
  page_icons_to_emoji`). It follows the precedent
  `plugins/database/plugins/migrations/data/20260927_182347_81e713f0__remap_saved_icons_to_symbols.sql`.
  One idempotent statement sets `icon` to `NULL` on:
  - `page_blocks.data` where `type='page'`;
  - `entity_versions` (source `pages`): the snapshot's `page.icon` and every page row inside it;
  - `search_documents` (source `pages`): `metadata.icon`.

  This must land before the strict schema reads. Check how the 0927 migration dealt with the
  `derived-updated-at` trigger: bumping `updated_at` on every page would reorder Recent pages.
  Suppress the bump the same way, or accept it.
- **`PageIcon`** (`plugins/page/plugins/editor/web/components/page-icon.tsx`) renders an emoji
  as a text glyph sized by the same `className`. It falls back to the `description` symbol.
  The `icon` prop type becomes `Emoji | null | undefined`.
- **Readers that follow from tsc:**
  - the backlinks projection decoder (`plugins/page/plugins/links/server/internal/resources.ts`);
  - the `isSavedSymbolName` guards in `content-search/web/components/pages-search.tsx`,
    `history/web/components/page-version-preview.tsx` and
    `read-only-view/web/components/read-only-blocks.tsx`, which switch to `isEmoji`;
  - `PageIconValue` in `page-tree/web/components/page-icon-button.tsx`.
- **Delete `plugins/page/plugins/editor/server/internal/saved-icons.ts`** (`page.page-icons`
  saved-icon source). Pages no longer contribute symbols to the sprite sheet.
- The callout's own `icon` is untouched; it stays a symbol.
- Markdown `<agent-page icon=…>` is out of scope.

### 3. Picker: `page-tree/web/components/page-icon-button.tsx`

`PageIconPicker` swaps `<IconPicker>` for `<EmojiPicker>`. The footer holds **Remove**
(as today) and **✨ Regenerate**. Regenerate is imported from the auto-icon web barrel and
calls its endpoint. It shows a pending state while the job runs; the new icon arrives
through the page's live row.

### 4. Generation: `apps/pages/plugins/auto-icon` (new plugin)

This copies two existing patterns:

- the debounced keyed job from `apps/pages/plugins/history` (`schedule-job.ts` + `snapshot-job.ts`);
- the Haiku call and guarded write-back from `task-title/server/internal/short-title-job.ts`
  + `generate-title.ts`.

**Provenance side-table.** `page_blocks_ext_auto_icon { pageId, emoji, generatedAt }` is
defined with `defineExtension(_blocks, "auto_icon", …)`, like `pages/plugins/starred`. The row
means "generation has run for this page", so it never auto-runs again. It cascades with the page.

**Trigger.** `Trigger({ on: blocksChanged, do: scheduleAutoIconJob })`.

- The schedule job (`hold: "instant"`) enqueues `autoIconJob({ pageId })` with
  `runAt: now + 10 s`.
- `autoIconJob` uses `dedup: { key: pageId }`, graphile's default `replace`, so every edit
  pushes it back. That is the "after a threshold" debounce, with no polling. Leaving the page
  needs no special signal: the edits simply stop.
- `blocksChanged` already lags typing by about 1 s (CRDT projection), which is fine.

**`autoIconJob`** uses `hold: "seconds"`, `serial: true` (one model call at a time) and
input `{ pageId, force?: boolean }`. It does the following:

1. Read the page row. Return if it is gone, not a page, or trashed.
2. Unless `force`, return if an ext row exists. That makes it once-only, and it also breaks
   the loop: our own icon write re-emits `blocksChanged`.
3. **Thin-content gate.** Skip, writing no ext row so a later edit retries, when the title is
   empty or `Untitled` and the body text is under about 20 chars.
4. Build the text like `content-search/server/internal/reindex-page.ts`: `liveBlocks` by
   `pageId`, joined with `textOf`, capped at 1500 chars. Read sibling pages' icons (same
   `parent_id`, `type='page'`).
5. Make a Haiku call through `runClaudePrint({ tier: "haiku", source: { name: "page-auto-icon" } })`
   with the tested prompt:
   - the system prompt holds the rules (a concrete object over a generic symbol; avoid
     📝📄📋✅💡⭐, flags and faces), with a few examples, e.g. a scratch/test page → 🧪;
   - the user turn wraps `<page_title>`, `<page_content>` and `<sibling_icons>`;
   - the output is `EMOJI:` / `ALT:`.

   Parse it with `isEmoji`. Take EMOJI unless a sibling already has it, else ALT. On an
   unusable answer, warn and write nothing.
6. **Write-back in one transaction**, locking the page row (`for update`) as short-title-job does:
   - Unless `force`, skip the icon write if `data.icon` is now non-null (the user picked one in
     the meantime).
   - Always upsert the ext row.
   - The icon goes through a **new editor export `setPageIcon(pageId, emoji | null, { tx })`**
     built on `page-row-write.ts:rewritePageRow`, the sanctioned page-row write funnel. The
     header's `saveIcon` could adopt it later.
7. **Regenerate** is `POST /api/pages/:id/auto-icon/regenerate`, which enqueues
   `autoIconJob({ pageId, force: true })` immediately.
8. **Backfill** copies `task-title/server/internal/short-title-backfill.ts`:
   - a `defineWarmup`-driven, `dedup: "singleton"` scan;
   - it enqueues `autoIconJob` for every live page with no ext row;
   - the keyed serial job does the model calls one at a time;
   - after the migration, every page qualifies. At ~2 s per call, a few hundred pages clear
     in minutes.

User-set icons are safe by construction. The job writes only where `data.icon` is null or
when forced, and after the first run it never runs again for that page. **Remove** sets the
icon to null, and it stays null because the ext row exists.

## Critical files

- New: `plugins/ui/plugins/icons/plugins/emoji/{core,web}`, `plugins/apps/plugins/pages/plugins/auto-icon/{core,server,web}`.
- Changed:
  - `plugins/page/plugins/editor/core/schemas.ts` (`PageDataSchema`);
  - `editor/web/components/page-icon.tsx`;
  - `editor/server/index.ts` (export `setPageIcon`; drop the `saved-icons` source);
  - `editor/server/internal/page-row-write.ts`;
  - `page-tree/web/components/page-icon-button.tsx`, `page-header.tsx`;
  - `links/server/internal/resources.ts`;
  - the three `isSavedSymbolName` guards;
  - `content-search/server/internal/reindex-page.ts` (metadata type);
  - the new migration SQL.
- Reused:
  - `runClaudePrint` (`infra/claude-cli/server`);
  - `defineJob` / `Trigger` (`infra/jobs`, `infra/events`);
  - `blocksChanged` (`page/editor/server`);
  - `defineExtension` (`infra/entity-extensions`);
  - `textOf` (`page/editor/core`);
  - `defineAssetMirror` (`infra/asset-mirror`);
  - `defineWarmup` (`infra/warmup`).

## Verification

- `./equin test`:
  - `isEmoji` (ZWJ family, skin tone, flag, keycap, and 🗺️ with VS16 all accepted; "ab",
    "rocket" and two emoji rejected);
  - the answer parser (EMOJI/ALT, sibling fallback, junk → no write).
- `./equin build`, then `query_db`:
  - no `page_blocks` page row has a non-emoji icon;
  - `page_blocks_ext_auto_icon` fills as the backfill drains;
  - `claude_cli_calls` rows are tagged `page-auto-icon`.
- E2E script `auto-icon/e2e/auto-icon-verify.ts`:
  1. Create a page and assert the document glyph.
  2. Type a title and body, then wait ~12 s; assert an emoji appears in the sidebar and header.
  3. Pick another emoji in the picker; edit the content; assert it is not overwritten.
  4. Click Regenerate and assert it changes.
  5. Click Remove, edit, and assert it stays empty.
- Screenshot the sidebar next to the mockup `proto-1790695854-vdde`.
