# Before / after screenshots for agents

## Context

When an agent changes UI, the user wants to see what changed without opening two
builds side by side. The agent should **publish a before/after pair** and the user
should **drag a divider** across it. Agreed flow (prototype `proto-1794734530-kvemse`,
`?start=transcript|pane|artifacts`):

1. The agent calls an MCP tool to register a pair.
2. The tool call in the transcript renders a **swipe preview**.
3. The preview opens a **Before / after pane**: a large viewer (Swipe / Side by side /
   Flip, full screen) plus the **list of every pair** of the conversation.
4. Every pair is listed in the conversation's **Artifacts** popover.
5. Every pair has an **id** (`ba-…`). An agent cites it in text, and it renders as an
   **active-data chip** (hover preview, click opens the pane on it).

The slider is the prototype canvas's swipe, extracted into a primitive.

## Design

### New plugins

| Plugin | Holds |
|---|---|
| `plugins/primitives/plugins/swipe-compare` (web) | `<SwipeCompare before after mode at? onAtChange? />`: swipe / side / flip, pointer + keyboard. No domain knowledge. |
| `plugins/conversations/plugins/before-after` (core / server / machine / web) | Id kind, table, live collection, MCP tool, tool-call renderer, pane, Artifacts kind. |
| `plugins/active-data/plugins/before-after` (web / server) | The `ba-…` chip (`idChip` / `idChipServer`), following `active-data/plugins/prototype`. |

### 1. `swipe-compare` primitive

- Extract the wipe from `SwipeFrames` (`plugins/apps/plugins/prototypes/plugins/canvas/web/components/canvas.tsx`):
  - The A-over-B `clipPath: inset(0 X% 0 0)` (built on `primitives/css/coords` `Placed`).
  - The pointer-captured divider.
  - It is about 40 lines and has no iframe dependency.
- Add what the canvas lacks:
  - Keyboard: ←/→ (Shift ×5), Home/End, `role="separator"` with `aria-valuenow`.
  - Click-to-jump on the track.
  - Double-click to recentre.
  - Before / After corner tags.
  - `side` and `flip` modes (flip: click or Space toggles).
- Controlled (`at` + `onAtChange`) or uncontrolled. `before` / `after` are ReactNodes, so the canvas keeps passing iframes and this feature passes `<img>`.
- **Refactor `SwipeFrames` to consume it**, so there is one swipe implementation. The canvas keeps `swipeAt` in its reducer and passes it in.
- Add an exhibit `swipe-compare/images` for visual checks.

### 2. Id kind + storage (`before-after/core`, `/server`)

- `baIdKind = defineIdKind({ prefix: "ba", label: "Before / after" })` (stamped: `ba-<epoch>-<6>`). Register it with `IdKinds.Kind` on **both** barrels.
- `before_after_pairs` entity (pattern: `conversations/plugins/session-chain/core/entity.ts`, `server/internal/tables.ts`):
  - Columns: `id`, `conversationId`, `toolUseId`, `title`, `route`, `width`, `height`, `colorScheme`.
  - `beforeAttachmentId` / `afterAttachmentId`.
  - `beforeLabel` / `afterLabel` (default "main" / "this build").
  - `createdAt`.
  - Indexed on (`conversationId`, `createdAt`) and on `toolUseId`.
- Images go through `infra/attachments`: `createAttachment(png, …)` plus `Attachments.defineLink` / `Attachments.Link` against the pair table. This keeps them durable, so the orphan sweep never reclaims them. Pattern: `tasks-core/core/attachment-links.ts`. Served as `GET /api/attachments/:id` (`assetPath(getAttachmentFile, …)`).
- `beforeAfterPairs = liveCollection(…)`, served by `serveCollection`. It supports read by `conversationId` (newest first, bounded `max`) and lookup by `id` and by `toolUseId`.

### 3. MCP tool `register_before_after` (`before-after/server`)

`Mcp.tool({ name: "register_before_after", inputSchema, handler })`, in `register: […]`. The input is one of two shapes (discriminated):

- **`{ route, title, width?, height?, colorScheme? }`**, the default: the tool captures `route` on **main** and on **this conversation's build** at the same viewport (default 1400×900).
  - Targets come from `resolveTarget(conversationId)` and `namespaceUrl(MAIN_WORKTREE_NAME)` (`infra/mcp/plugins/browser/server/internal/target.ts`).
  - An unbuilt worktree fails with "run ./equin build first".
- **`{ beforePath, afterPath, title, beforeLabel?, afterLabel? }`**: two PNG files the agent already made. This covers states that need interaction (e.g. `screenshot.ts --click`, which writes `-before.png` / `-after.png`) or a comparison other than main vs build.

Capture is a **new host operation on the browser MCP host**, `capturePair`:

- It opens two throwaway pages in the conversation's browser context, so the agent's own tabs are untouched.
- It waits until each page is ready (network idle, no `aria-busy`, not flat: the e2e-harness `screenshot.ts` readiness rules, moved where both can use them).
- It returns two PNGs. Its result is shaped like the existing tool table (`shared/tools.ts`, `bin/host-tools.ts`), and it bumps `HOST_PROTOCOL`.
- The browser plugin exports it from its server barrel. `before-after/server` imports it, so the dependency goes one way.

The handler:

1. Mints the id.
2. Stores the two attachments and inserts the row (with `ctx.toolUseId`).
3. Returns the id, plus both images as MCP image content, so the agent sees what it published.

### 4. Transcript renderer (`before-after/web`)

- `JsonlViewerTool.Renderer({ match: /register_before_after$/, input, component })`.
- The card reads the pair by `toolUseId` (`useLive(beforeAfterPairs, …)`). It draws:
  - title and route;
  - the id chip;
  - an "open in pane" icon;
  - a compact `<SwipeCompare>` (max ~460 px wide).
- Before the row lands it shows the loading state, never an empty card.

### 5. Pane (`before-after/web`)

- One pane keyed by **pair id**: `Pane.define({ route: defineRoute({ id: "before-after", segment: "before-after;pair" }), app: agentManagerApp, … })`, plus `Pane.Register`.
  - It is keyed by the pair rather than as a conversation satellite, so the chip can open it from anywhere (another conversation, a page). The pair's row gives the conversation, and the list shows that conversation's pairs.
- Body:
  - Header: title, id chip, route · size · labels; the mode segmented control.
  - `<SwipeCompare>` filling the space.
  - A full-screen action (`primitives/overlay`), with ←/→ stepping through the pairs.
  - Below: a **simple horizontal gallery** of every pair in that conversation: a split before|after thumbnail with its title under it, and the selected one ringed in the accent colour.
    - No search, no toolbar, no columns: the prototype's filmstrip, pixel for pixel.
    - It is still a DataView (`views={["gallery"]}`, chrome hidden), per the repo rule. If the gallery view cannot render a single scrolling row without chrome, extend the gallery view rather than hand-rolling a `.map()`.
    - Clicking an item selects that pair in the same pane (the `pair` param).

### 6. Artifacts kind

- Server: `ConversationArtifactExtractor({ id: "before-after", origin: "produced", extract })`. One hit per `register_before_after` tool call, `key = toolUseId`, relation `created`.
  - It is `produced`, so it counts in the button badge.
- Web: `ConversationArtifacts.Kind({ id: "before-after", label: "Before / after", icon, Section })`.
  - The section is a thumbnail grid (`ImageGallery`-like, split before|after).
  - Clicking a pair opens the pane on it.
  - Pattern: `plugins/debug/plugins/browser-recordings/{server,web}/index.ts`.

### 7. Id chip (`active-data/plugins/before-after`)

- `idChip({ presenter: { kind: baIdKind, icon, useReferent, usePane }, surfaces: ["transcript", "document"] })`:
  - `useReferent` = `rowReferent(useLive(beforeAfterPairs, { id }), (r) => r.title)`.
  - `usePane` = `paneTarget(beforeAfterPane, { pair: id })`.
- Server: `idChipServer({ kind, resolve: title from the row })`.
- Hover preview: if the generic chip has a hover slot, contribute a thumbnail there. Otherwise this is a follow-up, not part of v1.

### 8. Agent guidance

- The tool description says when to use it: after a visible UI change, one call per screen or state, and cite the returned id in the final message.
- Add a line to the project `CLAUDE.md` "Driving the app" section pointing to it.

## Critical files

- New: `plugins/primitives/plugins/swipe-compare/web/…`, `plugins/conversations/plugins/before-after/{core,server,web}/…`, `plugins/active-data/plugins/before-after/{server,web}/…`
- Edit: `plugins/apps/plugins/prototypes/plugins/canvas/web/components/canvas.tsx` (consume the primitive)
- Edit: `plugins/infra/plugins/mcp/plugins/browser/{shared/tools.ts,bin/host-tools.ts,server/index.ts}` (`capturePair`)
- Reuse: `ids/core` (`defineIdKind`), `infra/attachments`, `network/live`, `JsonlViewerTool.Renderer`, `ConversationArtifacts.Kind` / `ConversationArtifactExtractor`, `active-data/plugins/id-chip`, `primitives/pane`, `primitives/data-view`

## Verification

1. **Build and check:** `./equin build`, then `./equin check`.
2. **Unit tests** (`./equin test plugins/conversations/plugins/before-after plugins/primitives/plugins/swipe-compare`):
   - The extractor finds the calls.
   - The input union parses.
   - SwipeCompare keyboard and clamping (jsdom).
3. **End-to-end:** an `e2e/` script in `before-after`:
   - Have this conversation call `register_before_after` on `/agents`.
   - Open the conversation, then assert the card renders both images.
   - Drag the divider.
   - Click the id chip, then assert the pane opens with the list.
   - Open Artifacts, then assert the section lists the pair.
4. **Regression:** the canvas swipe still drags (existing `canvas` e2e) after the refactor.
5. **Pixel check:** compare against the prototype with `compare-diff.ts --name proto-1794734530-kvemse`.

## Out of scope (v1)

- Automatic pixel-diff overlay.
- Comparing two arbitrary builds (the file-path input covers it manually).
- Pairs shown on the task's detail page.
- Chip hover preview, if the id-chip primitive has no hover slot.
