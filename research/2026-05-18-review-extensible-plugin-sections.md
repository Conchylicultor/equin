# Extensible per-plugin sections in the review pane

## Context

The review pane shows a list of changed plugins (via the `plugin-changes` sub-plugin). Currently, when a plugin card is expanded, the API diff content is hardcoded directly in `PluginChangeCard`. This makes it impossible for other plugins to contribute additional review sections (e.g. "file changes", "test coverage", etc.).

The goal is to make per-plugin expanded content extensible via a slot, and extract the current API diff rendering as the first sub-plugin contributing to that slot. Each contribution should be able to render in **two places**: the expanded body AND the plugin card's summary header (for badges, icons, counts).

## Design

### Slot definition

`plugin-changes` defines a new `PluginChanges.Section` render slot. Each contribution provides:

```ts
// plugins/review/plugins/plugin-changes/web/slots.ts

import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { ComponentType } from "react";
import type { PluginChangeDiff } from "../core";

export type PluginReviewProps = {
  conversationId: string;
  plugin: PluginChangeDiff;
};

export const PluginChanges = {
  Section: defineRenderSlot<{
    label: string;
    component: ComponentType<PluginReviewProps>;
    summary?: ComponentType<PluginReviewProps>;
    hasContent?: (plugin: PluginChangeDiff) => boolean;
  }>("review.plugin-changes.section"),
};
```

- `component` — body content rendered in the expanded card
- `summary` — optional badge/chip rendered in the card header alongside the plugin name
- `hasContent` — optional callback; card auto-expands if any contribution returns `true`

### Dual-render in the card host

`PluginChangeCard` becomes a custom host using both `useContributions()` (for summaries) and `<Section.Render>` (for bodies with middleware):

```tsx
// plugins/review/plugins/plugin-changes/web/components/plugin-change-card.tsx

function PluginChangeCard({ conversationId, plugin }: PluginReviewProps) {
  const sections = PluginChanges.Section.useContributions();
  const hasExpandable = sections.some(s => s.hasContent?.(plugin) ?? false);
  const [expanded, setExpanded] = useState(hasExpandable);

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      {/* Header — base info + contributed summaries */}
      <button onClick={() => setExpanded(!expanded)} className="...">
        <ChevronIcon expanded={expanded} />
        <span>{plugin.hierarchyId}</span>
        <StatusBadge status={plugin.status} />
        {/* Contributed summary badges */}
        {sections.map(s => {
          const S = s.summary;
          return S ? <S key={s.id} conversationId={conversationId} plugin={plugin} /> : null;
        })}
      </button>

      {/* Body — contributed sections with middleware (error boundaries) */}
      {expanded && hasExpandable && (
        <div className="...">
          <PluginChanges.Section.Render>
            {(item) => {
              if (item.hasContent && !item.hasContent(plugin)) return null;
              const C = item.component;
              return <C conversationId={conversationId} plugin={plugin} />;
            }}
          </PluginChanges.Section.Render>
        </div>
      )}
    </div>
  );
}
```

This approach uses `useContributions()` for the header (simple, no middleware needed for small badges) and `<Section.Render>` for the body (gets error boundary middleware). A single contribution targets one slot but carries both rendering points as separate fields — matching the `headerExtra` precedent in `defineDetailSections`.

### Extract `api-changes` sub-plugin

The current `DiffSection` component and `hasDiffs()` logic move to a new sub-plugin:

```
plugins/review/plugins/plugin-changes/plugins/api-changes/
  web/
    index.ts                    → contributes PluginChanges.Section
    components/
      api-changes-section.tsx   → DiffSection rendering (extracted from plugin-change-card.tsx)
      api-changes-summary.tsx   → compact badge showing API change count
```

Contribution:

```ts
// plugins/review/plugins/plugin-changes/plugins/api-changes/web/index.ts

import { PluginChangesSlots } from "@plugins/review/plugins/plugin-changes/web";
import { ApiChangesSection } from "./components/api-changes-section";
import { ApiChangesSummary } from "./components/api-changes-summary";
import { hasDiffs } from "./components/api-changes-section";

export default {
  id: "review-plugin-changes-api",
  name: "Review: API Changes",
  description: "API surface diff section for per-plugin review cards.",
  contributions: [
    PluginChangesSlots.Section({
      id: "api-changes",
      label: "API Changes",
      component: ApiChangesSection,
      summary: ApiChangesSummary,
      hasContent: (plugin) => hasDiffs(plugin),
    }),
  ],
} satisfies PluginDefinition;
```

### Summary badge component

The `ApiChangesSummary` renders a small count badge in the card header:

```tsx
// Counts total API additions + removals, renders e.g. "4 API" as a subtle badge
function ApiChangesSummary({ plugin }: PluginReviewProps) {
  const count = totalDiffCount(plugin); // sum of all 7 diff categories
  if (count === 0) return null;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-600 dark:text-purple-400">
      {count} API
    </span>
  );
}
```

### File stats

The file stats (`5f +30 -10`) stay in the base `PluginChangeCard` header since they're generic metadata from `PluginChangeDiff`. A future `file-changes` sub-plugin could contribute a richer summary that replaces or supplements these.

## Files to modify

| File | Action |
|------|--------|
| `plugins/review/plugins/plugin-changes/web/slots.ts` | **Create** — define `PluginChanges.Section` render slot |
| `plugins/review/plugins/plugin-changes/web/index.ts` | **Edit** — re-export `PluginChangesSlots` from slots.ts |
| `plugins/review/plugins/plugin-changes/core/protocol.ts` | **Edit** — export `PluginReviewProps` type |
| `plugins/review/plugins/plugin-changes/web/components/plugin-change-card.tsx` | **Refactor** — remove inline DiffSection/hasDiffs; become custom slot host |
| `plugins/review/plugins/plugin-changes/web/components/plugin-changes-section.tsx` | **Edit** — pass `conversationId` to each `PluginChangeCard` |
| `plugins/review/plugins/plugin-changes/plugins/api-changes/web/index.ts` | **Create** — sub-plugin definition |
| `plugins/review/plugins/plugin-changes/plugins/api-changes/web/components/api-changes-section.tsx` | **Create** — extracted DiffSection + hasDiffs |
| `plugins/review/plugins/plugin-changes/plugins/api-changes/web/components/api-changes-summary.tsx` | **Create** — API change count badge |
| `plugins/review/plugins/plugin-changes/plugins/api-changes/package.json` | **Create** — workspace package manifest |

No server changes needed — the `/api/review/plugin-changes` endpoint and `PluginChangeDiff` type are unchanged.

## Verification

1. `./equin build` — should succeed, auto-discover the new `api-changes` sub-plugin
2. Open the review pane on a conversation with plugin changes
3. Verify plugin cards show the API change count badge in the header
4. Verify expanding a card shows the same API diff content as before
5. `./equin check` — all checks pass
