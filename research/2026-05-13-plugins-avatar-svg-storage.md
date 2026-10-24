# Avatar: Eliminate two-tier icon system, store SVG at write time

## Context

On cold page load, avatar icons picked from the full 2160-icon set render as blank discs. `resolveAvatarIcon` depends on a lazily-loaded `react-icons/md` module that only loads when `AvatarPicker` is opened. The 84-icon "curated" set that resolves synchronously is an arbitrary distinction — no avatar icon is more special than another.

**Fix:** Store SVG path data alongside the icon key at write time. `<Avatar>` renders raw `<svg>` from stored paths. The full `react-icons/md` module loads only in the picker for browsing — never for rendering.

## Implementation

### Step 1 — Simplify `icons.ts`: remove curated set, add SVG extraction

**File:** `plugins/primitives/plugins/avatar/web/internal/icons.ts`

**Add:**
- `SvgNode` type: `{ tag: string; attr: Record<string, string>; child: SvgNode[] }`
- `extractSvgNodes(Icon: IconType): SvgNode[]` — calls `Icon({})`, walks the React element tree, filters sentinel `fill:none` bounding paths
- Hardcoded `DEFAULT_AGENT_AVATAR.svgNodes` for `MdPrecisionManufacturing` (inlined, no import)

**Remove:**
- All 84 static `import { MdXxx } from "react-icons/md"` (lines 2-15)
- `AVATAR_ICONS`, `AVATAR_ICON_KEYS`, `CURATED_TAGS`, `searchCuratedIcons`/`searchIcons`
- `AVATAR_ICON_CATEGORIES_FLAT`, `AVATAR_ICON_CATEGORIES`
- `resolveAvatarIcon`, `_mdCache`

**Keep:** `loadFullIconSet()`, `CATEGORY_LABELS`, `mdNameToReactKey`, `icon-metadata.json`, all `FullIcon*` types

### Step 2 — Update `AvatarSpec` and `AvatarPicker`

**File:** `plugins/primitives/plugins/avatar/web/components/avatar-picker.tsx`

- `AvatarSpec` gains `svgNodes: SvgNode[] | null`
- `pickIcon` extracts SVG nodes on click: `extractSvgNodes(entry.Icon)` — no upfront extraction for all 2160 icons
- Remove curated fallback grid. Before full set loads, show a loading spinner. After, show the full categorized grid.
- Remove imports: `AVATAR_ICONS`, `AVATAR_ICON_CATEGORIES_FLAT`, `searchCuratedIcons`
- Clear button: `{ icon: null, color: null, svgNodes: null }`

### Step 3 — Rewrite `Avatar` to render from stored SVG nodes

**File:** `plugins/primitives/plugins/avatar/web/components/avatar.tsx`

- Add `svgNodes?: SvgNode[] | null` to `AvatarProps`
- Remove `resolveAvatarIcon` import
- Render `<svg viewBox="0 0 24 24">` with recursive `renderSvgNodes` helper using `React.createElement`
- `icon` prop retained for fallback color hashing

### Step 4 — Add `icon_svg_nodes` DB columns

- `plugins/agents/server/internal/tables.ts`: add `iconSvgNodes: text("icon_svg_nodes")`
- `plugins/conversations/plugins/conversation-category/server/internal/tables-colors.ts`: add `iconSvgNodes: text("icon_svg_nodes")`

Run `./equin build` to generate the migration.

### Step 5 — Update Zod schemas, API handlers, and resources

**Agents:**
- `plugins/agents/shared/schemas.ts`: add `iconSvgNodes: z.string().nullable()` to `AgentSchema`
- `plugins/agents/server/internal/handle-update.ts`: accept and store `iconSvgNodes` in body/patch
- `plugins/agents/server/internal/handle-create.ts`: accept and store `iconSvgNodes`

**Category colors:**
- `plugins/conversations/plugins/conversation-category/server/internal/colors-resource.ts`: add `iconSvgNodes` to `CategoryAvatarOverrideSchema` and `loader` output
- `plugins/conversations/plugins/conversation-category/server/internal/colors-routes.ts`: accept `iconSvgNodes` in `handleSetColor`, include in `handleGetColors` output
- `plugins/conversations/plugins/conversation-category/web/internal/use-category-colors.ts`: add `iconSvgNodes` to local `CategoryAvatarOverrideSchema`

### Step 6 — Server-side backfill for existing rows

Both the agents and conversation-category plugins need to backfill existing rows that have an `icon`/`icon_key` but no `icon_svg_nodes`. The backfill runs once in `onReady`.

**Shared resolution logic** — new file: `plugins/primitives/plugins/avatar/server/index.ts`

This gives the avatar plugin a server barrel exporting:
```ts
export async function resolveIconSvgNodesJson(iconKey: string): Promise<string | null>
```

This function:
1. Lazily `import("react-icons/md")` (cached after first call)
2. Resolves `iconKey` → React component name: check `CURATED_ALIASES` first (23 keys where curated ≠ mdName, e.g. `robot → MdPrecisionManufacturing`), then `mdNameToReactKey` for all other keys
3. Calls the component, walks the element tree, serializes
4. Returns JSON string or null

**Curated alias map** (hardcoded constant, 23 entries):
```
robot→MdPrecisionManufacturing, bug→MdBugReport, database→MdStorage,
server→MdDns, data→MdDataObject, brain→MdPsychology,
sparkle→MdAutoAwesome, fire→MdLocalFireDepartment, trending→MdTrendingUp,
music→MdMusicNote, video→MdVideocam, emoji→MdEmojiObjects,
doc→MdDescription, grid→MdGridView, table→MdTableChart,
calendar→MdCalendarToday, clock→MdAccessTime, account→MdManageAccounts,
globe→MdLanguage, play→MdPlayArrow, chart→MdBarChart,
pie→MdPieChart, currency→MdAttachMoney
```

**Backfill callers:**
- `plugins/agents/server/index.ts` `onReady`: query rows with `icon IS NOT NULL AND iconSvgNodes IS NULL`, resolve each, update
- `plugins/conversations/plugins/conversation-category/server/index.ts` `onReady`: same for `_conversationCategoryColors` rows

### Step 7 — Update all consumers

**`plugins/agents/web/components/agent-detail.tsx`:**
- onChange: `save({ icon: next.icon, iconColor: next.color, iconSvgNodes: next.svgNodes ? JSON.stringify(next.svgNodes) : null })`
- Avatar: pass `svgNodes={agent.iconSvgNodes ? JSON.parse(agent.iconSvgNodes) : DEFAULT_AGENT_AVATAR.svgNodes}`
- Add `iconSvgNodes` to the `Patch` type

**`plugins/agents/web/components/agent-avatar-row.tsx`:**
- Pass `svgNodes={agent?.iconSvgNodes ? JSON.parse(agent.iconSvgNodes) : DEFAULT_AGENT_AVATAR.svgNodes}` to Avatar

**`plugins/agents/web/components/agent-avatar-title-prefix.tsx`:**
- Same svgNodes pattern

**`plugins/agents/web/components/agents-list.tsx`:**
- Remove `randomFrom(AVATAR_ICON_KEYS)` / `randomFrom(AVATAR_COLOR_KEYS)` on agent create — new agents start with `icon: null` (default robot avatar)
- Remove `AVATAR_ICON_KEYS`, `AVATAR_COLOR_KEYS` imports and `randomFrom` helper

**`plugins/conversations/plugins/conversation-category/web/components/category-color-settings.tsx`:**
- `setAvatar`: include `iconSvgNodes: spec.svgNodes ? JSON.stringify(spec.svgNodes) : null` in POST body
- Construct AvatarSpec with `svgNodes: override?.iconSvgNodes ? JSON.parse(override.iconSvgNodes) : null`
- Pass `svgNodes` to Avatar

**`plugins/conversations/plugins/conversation-category/web/components/category-avatar-row.tsx`:**
- Pass `svgNodes={override?.iconSvgNodes ? JSON.parse(override.iconSvgNodes) : null}` to Avatar

### Step 8 — Update barrel exports

**`plugins/primitives/plugins/avatar/web/index.ts`:**
- Remove: `AVATAR_ICONS`, `AVATAR_ICON_KEYS`, `AVATAR_ICON_CATEGORIES`, `resolveAvatarIcon`, `searchIcons`
- Add: `SvgNode` (type), `extractSvgNodes`
- Keep: `loadFullIconSet`, `DEFAULT_AGENT_AVATAR` (now with `svgNodes`), all color exports, all `FullIcon*` types

## Files modified

| File | Change |
|------|--------|
| `plugins/primitives/plugins/avatar/web/internal/icons.ts` | Remove curated set, add SvgNode + extractSvgNodes, hardcode DEFAULT svgNodes |
| `plugins/primitives/plugins/avatar/web/components/avatar-picker.tsx` | AvatarSpec gains svgNodes, remove curated fallback |
| `plugins/primitives/plugins/avatar/web/components/avatar.tsx` | Render from svgNodes, remove resolveAvatarIcon |
| `plugins/primitives/plugins/avatar/web/index.ts` | Update exports |
| `plugins/primitives/plugins/avatar/server/index.ts` | **New** — server barrel with resolveIconSvgNodesJson for backfill |
| `plugins/agents/server/internal/tables.ts` | Add iconSvgNodes column |
| `plugins/agents/shared/schemas.ts` | Add iconSvgNodes to AgentSchema |
| `plugins/agents/server/internal/handle-update.ts` | Accept iconSvgNodes |
| `plugins/agents/server/internal/handle-create.ts` | Accept iconSvgNodes |
| `plugins/agents/server/index.ts` | Add backfill in onReady |
| `plugins/agents/web/components/agent-detail.tsx` | Pass svgNodes through write + read |
| `plugins/agents/web/components/agent-avatar-row.tsx` | Pass svgNodes to Avatar |
| `plugins/agents/web/components/agent-avatar-title-prefix.tsx` | Pass svgNodes to Avatar |
| `plugins/agents/web/components/agents-list.tsx` | Remove random icon on create |
| `plugins/conversations/plugins/conversation-category/server/internal/tables-colors.ts` | Add iconSvgNodes column |
| `plugins/conversations/plugins/conversation-category/server/internal/colors-resource.ts` | Add iconSvgNodes to schema + loader |
| `plugins/conversations/plugins/conversation-category/server/internal/colors-routes.ts` | Accept/return iconSvgNodes |
| `plugins/conversations/plugins/conversation-category/server/index.ts` | Add onReady with backfill |
| `plugins/conversations/plugins/conversation-category/web/internal/use-category-colors.ts` | Add iconSvgNodes to local schema |
| `plugins/conversations/plugins/conversation-category/web/components/category-color-settings.tsx` | Pass svgNodes through write + read |
| `plugins/conversations/plugins/conversation-category/web/components/category-avatar-row.tsx` | Pass svgNodes to Avatar |

## Verification

1. `./equin build` — generates migration, builds successfully
2. Open the app — existing agent avatars render correctly (backfill resolves stored keys to SVG data)
3. Open an agent detail → click avatar → pick a full-set icon (e.g. "precision_manufacturing") → icon renders immediately
4. Reload the page — the icon persists (rendered from stored SVG, no lazy load needed)
5. Open Settings → Category avatars → pick icons for categories → verify they persist across reload
6. Create a new agent → verify it gets the default robot avatar
7. `./equin check` passes
