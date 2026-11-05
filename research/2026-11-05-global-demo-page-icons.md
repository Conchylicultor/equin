# Demo Pages: page icons in the seed, and an emoji picker that works in /demo

Track: "apps running in the browser, on fake or local data" (wiki page
block-d04c6c0d-56fd-49f2-88f4-914e059cc83b).

## Context

In `/demo`, every page in the Pages sidebar shows the default document glyph,
and a visitor can't set an icon. There are two causes, both verified:

1. **The seed writes no icons.** Pages' fixture writer
   (`apps/pages/fixtures/server/internal/write-page-tree.ts`) hard-codes
   `icon: null`, and `PageFixture` has no icon field. On main every root page
   carries an icon (9/9) and none has a cover. So covers are out of scope: the
   real app doesn't show them prominently.
2. **The picker says "not available".** `EmojiPicker`
   (`ui/icons/emoji/web/components/emoji-picker.tsx`) hands frimousse an
   `emojibaseUrl` from `useAssetUrl`. Inside the demo the transport serves no
   URLs (`fetch-only`), and frimousse's `defaultEmojiDataResolver` loads with
   the GLOBAL `fetch` and offers no fetch hook. A page's icon is an emoji only
   (`PageDataSchema.icon = EmojiSchema`), so Material Symbols / saved icons
   are not in play for pages.

The worker already serves `GET /api/asset-mirror/emojibase/…`: the emoji
server barrel and `infra/asset-mirror` are in the lumen browser-host graph.
Only the page-side loading is missing.

## Approach

### 1. The picker loads its data through the transport (one path, every host)

frimousse takes a `resolveEmojiData` resolver. The picker always passes its own
resolver, which reads `<base>/en/data.json` and `<base>/en/messages.json`
through `assetFetchOver(transport, EMOJIBASE)` (`infra/endpoints/web`, the hook
Sonata's samplers already load through). On the page's own server that fetches
the same path as before. On the demo's in-browser server it is the worker's
answer. On a transport whose route needs the computer it is `unavailable`, and
the picker shows that message, as it does today. One code path for every host,
with no demo branch.

- New `web/components/emoji-data.ts`:
  - zod schemas for the emojibase fields it reads, parsed at the fetch boundary.
  - The transform frimousse's default resolver applies: groups minus
    `component`, capitalized labels, skins keyed by tone, multi-tone skins
    as `aliases`, `countryFlag` from the flag subgroups.
  - Version filter `version <= emojiVersion`.
  - Memoized per transport (`transportScoped`). A failed load is dropped, so
    the next mount retries rather than caching the failure.
- The "Recent" leading category composes over it (`withLeadingCategory`
  unchanged).
- Behaviour kept: the version cap (15.1), and country flags left out where
  the browser cannot draw them (frimousse's canvas probe, ported to
  `country-flags.ts`). Behaviour dropped: frimousse's localStorage copy and
  its HEAD revalidation. The browser's HTTP cache of the immutable mirror
  files and the in-memory memo replace them.

### 2. The seed carries icons, written through Pages' real write path

- `PageFixture` gains `icon?: Emoji`, and `writePageTree` writes it into the
  page row's `data.icon` (the same `applyPageBlockPatch` create).
- Lumen's `DEMO_PAGES`: Lumen 💡, Theme & storage spec 📐, Bugs 🐛, Ideas 💭.
  "Dark mode investigation" is an agent page the seed mints through the real
  page tools, which carry no icon (an agent can't set one), so it keeps the
  default glyph, as it does on main.

### 3. e2e

`apps/demo/e2e/persistence.ts` gains a step:
1. Open a seeded page and assert its header icon is the seeded emoji.
2. Open the icon picker, assert the grid loads (no "not available"), search
   and pick an emoji.
3. Reload and assert the page's icon is the picked one.

no-leak stays green (the data goes through the worker).

## Verification

- `./equin test plugins/ui/plugins/icons/plugins/emoji plugins/apps/plugins/pages/plugins/fixtures`
  (new resolver test over a fake fetch; the fixture writer writes the icon).
- `./equin build`. Screenshots of /demo's Pages sidebar and of the picker open.
  Then the demo e2e: no-leak, app-switch, desktop-in-demo, prototypes-in-demo,
  sonata-in-demo, persistence.
- Real app: the picker on this worktree's own Pages still loads (same path,
  page transport).
