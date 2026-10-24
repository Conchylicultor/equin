# Collapsed Plugin Flag

## Context

`docs/plugins-compact.md` is auto-loaded into every agent's context window. At 381 lines and ~420 plugin entries, it's already large. As plugins grow to thousands, this becomes unsustainable.

The first scaling step: let umbrella plugins opt into collapsing. A collapsed plugin shows as `**plugin** [52 sub-plugins]` in compact, hiding its subtree. The elided TOC moves into the plugin's own `CLAUDE.md` autogen section, so agents working inside the plugin still see the full tree.

Top candidates by descendant count:
- `conversations.conversation-view` — 52 descendants
- `primitives` — 46 descendants
- `conversations.conversation-view.jsonl-viewer` — 18 descendants
- `ui.tokens` — 7 descendants

## Design

### The flag

`collapsed: true` in any barrel file (`web/index.ts`, `server/index.ts`, `central/index.ts`), parsed by the existing `parseBoolField` regex — same mechanism as `loadBearing`. The count shown is **total descendants** (recursive), not direct children, since the purpose is to communicate how much is hidden.

### Format in compact

```
- **`conversation-view`** [load-bearing] [52 sub-plugins] — Conversation pane host.
```

Square brackets match the existing `[load-bearing]` marker style. Singular form `[1 sub-plugin]` when count is 1.

### CLAUDE.md autogen for collapsed plugins

The autogen section gets the full recursive sub-plugin tree (rendered in compact mode — names + descriptions, no body), replacing the current flat direct-children list:

```markdown
## Plugin reference

- Description: Conversation pane host.
- Load-bearing: yes
- Collapsed in compact index: yes
- Sub-plugins:
  - **`action-bar`** — Hosts the Conversation.ActionBar slot.
  - **`code`** — Meta plugin hosting code-related contributions.
    - Plugins:
      - **`docs-button`** — Toolbar button that opens edited markdown docs.
      - **`file-pane`** — Hosts the file-peek pane.
        - Plugins:
          - **`diff`** — Side-by-side diff.
          ...
```

Nested collapsed children render as `[N sub-plugins]` within the parent's CLAUDE.md too — their own CLAUDE.md carries the next level.

## Changes

### 1. `PluginNode` type + parsing

**File:** `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`

- Add `collapsed: boolean` to the `PluginNode` interface (after `loadBearing`, line 82)
- Parse in `collectPlugin()` after the `loadBearing` block (line 626):
  ```ts
  const collapsed =
    (webSrc ? parseBoolField(webSrc, "collapsed") : false) ||
    (serverSrc ? parseBoolField(serverSrc, "collapsed") : false) ||
    (centralSrc ? parseBoolField(centralSrc, "collapsed") : false);
  ```
- Add `collapsed` to the node object literal (after `loadBearing`, ~line 716)

### 2. Docgen rendering

**File:** `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts`

**Add `countDescendants` helper** (before `renderPluginTreeMd`):
```ts
function countDescendants(p: PluginNode): number {
  let n = 0;
  for (const c of p.children) n += 1 + countDescendants(c);
  return n;
}
```

**Modify `renderPluginTreeMd`** (line 159): In compact mode, when `p.collapsed && p.children.length > 0`, emit the one-liner with `[N sub-plugins]` and return early (skip child recursion). Detail mode is unchanged.

**Modify `renderPluginClaudeAutogen`** (line 235): When `p.collapsed`, replace the flat child list with recursive `renderPluginTreeMd(c, 1, root, "compact")` calls to produce the full nested TOC.

**Update `COMPACT_HEADER`** (line 204): Mention that collapsed plugins show `[N sub-plugins]` and to open the plugin's `CLAUDE.md` for the full sub-tree.

### 3. Wire type for UI

**File:** `plugins/plugin-meta/plugins/plugin-view/core/types.ts`
- Add `collapsed: boolean` to the wire `PluginNode` interface (after `loadBearing`, line 76)

**File:** `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts`
- Add `collapsed: node.collapsed` to `toApiNode` return (after `loadBearing`, line 53)

### 4. Plugin definition types (type safety for barrel authors)

Add `collapsed?: boolean` after `loadBearing?: boolean` in:
- `plugins/framework/plugins/web-sdk/core/types.ts` — `PluginDefinition` (line 53)
- `plugins/framework/plugins/server-core/core/types.ts` — `ServerPluginDefinition` (line 64)
- `plugins/framework/plugins/central-core/core/types.ts` — `CentralPluginDefinition` (line 38)

### 5. Mark initial candidates

Add `collapsed: true` to barrel files of:
- `plugins/conversations/plugins/conversation-view/web/index.ts`
- `plugins/primitives/web/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web/index.ts`

(Final list to be confirmed — these are the biggest subtrees.)

## Verification

1. Run `./equin build` — regenerates `plugins-compact.md`, `plugins-details.md`, per-plugin `CLAUDE.md` files
2. Check `docs/plugins-compact.md`:
   - Collapsed plugins show `[N sub-plugins]` with correct count
   - Their children are NOT listed
   - Non-collapsed plugins render as before
3. Check `docs/plugins-details.md`: unchanged — full tree always shown
4. Check collapsed plugins' `CLAUDE.md` autogen blocks:
   - Full nested sub-plugin tree is present
   - Indentation is correct (2-space aligned with `- Sub-plugins:` header)
5. Check the Forge UI (`/forge`): plugin detail pane still loads, `collapsed` field is visible on the wire payload
6. Run `./equin check` — all checks pass
7. Verify line count reduction: `wc -l docs/plugins-compact.md` should drop significantly
