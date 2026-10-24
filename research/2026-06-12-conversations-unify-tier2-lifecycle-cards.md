# Unify tier-2 lifecycle "card" rows onto one CollapsibleCard chrome

_2026-06-12 · jsonl-viewer / meta-prompt + preprompt_

## Context

The conversation JSONL viewer renders lifecycle events in two visual tiers:

- **Tier-1 one-liners** (`queue-operation`, `system`, `task-notification`) were
  recently unified onto a shared `EventLine` grammar — a leading colored indicator +
  natural-case muted eyebrow + trailing content — so they read as siblings instead of
  each inventing its own chrome.
- **Tier-2 cards** (boxed, readable, injected-content blocks) are *not* yet unified.
  `preprompt` already uses the shared `CollapsibleCard` primitive (primary "Instructions"
  callout), but `meta-prompt` is still a **bespoke hand-rolled dashed `<div>`** with a
  manual two-zone header/body layout and no collapse. The two are conceptually siblings —
  both are harness/launch-injected, boxed, readable blocks — yet look unrelated.

This change brings `meta-prompt` onto the same `CollapsibleCard` chrome that `preprompt`
already uses, so the two tier-2 cards read as siblings (same disclosure behavior, same
canonical card structure) differing only by **icon + label + accent**. `CollapsibleCard`
is already the shared grammar (the tier-2 analog of `EventLine`), so the unification is
simply: convert `meta-prompt` to compose it — no new wrapper component is needed.

### Design constraint (from the same-day design-system doc)

`research/2026-06-12-conversations-transcript-card-design-system.md` collapsed all card
chrome to **one** uniform muted tone (`border-border/50 bg-muted/20`) and reserves chrome
*color* tints for exactly three sanctioned accents: the tool-identity chip, the `error`
flag, and **the single Instructions (preprompt) callout** (`border-primary/30 bg-primary/5`).
It deliberately kept `meta-prompt` dashed to read as "harness, not human."

**Decision (confirmed with user): Neutral + dashed border.** `meta-prompt` adopts the
default uniform muted `CollapsibleCard` chrome with **no color tint**, a muted icon+label,
and only a `border-dashed` override to preserve the "harness, not human" cue. `preprompt`
stays the single sanctioned colored callout. This unifies the *structure* without
introducing a second colored chrome family — consistent with the design doc.

## Scope

**One file rewritten**, mirroring `preprompt-row.tsx` byte-for-byte in shape:

- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/meta-prompt/web/components/meta-prompt-row.tsx`

No barrel, contribution, schema, or other plugin changes. `meta-prompt/web/index.ts`
stays as-is (still registers `JsonlViewer.EventRenderer({ match: "meta-prompt", ... })`).

## Implementation

Rewrite `meta-prompt-row.tsx` to compose `CollapsibleCard` instead of the bespoke box,
structurally identical to `preprompt-row.tsx`:

```tsx
import { MdReplay } from "react-icons/md";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Text } from "@plugins/primitives/plugins/text/web";

type MetaPromptEvent = Extract<JsonlEvent, { kind: "meta-prompt" }>;

export function MetaPromptRow({ event }: { event: JsonlEvent }) {
  const e = event as MetaPromptEvent;

  return (
    <CollapsibleCard
      className="border-dashed"
      label={
        <span className="flex items-center gap-1.5">
          <MdReplay className="size-3.5" />
          Resumed by harness{e.source ? ` · ${e.source}` : ""}
        </span>
      }
    >
      <Text as="div" variant="caption" className="whitespace-pre-wrap break-words text-muted-foreground">
        {e.text}
      </Text>
    </CollapsibleCard>
  );
}
```

Key points / rationale for each decision:

- **`className="border-dashed"` only** — inherit the canonical chrome
  (`border-border/50 bg-muted/20`, `px-3 py-2`) and add *only* the dashed border-style.
  `cn`/`twMerge` keeps both: `border-dashed` (border-style) and the base `border-border/50`
  (border-color) live in different property groups, so the dashed cue layers cleanly over
  the uniform muted chrome. Do **not** re-introduce the old `bg-muted/30 border-border/70` —
  adopting the canonical fill is the whole point of unifying.
- **No color on the label** — the header is already `text-2xs text-muted-foreground` inside
  `CollapsibleCard`. Unlike `preprompt` (which wraps its label in `text-primary`), the
  meta-prompt label stays muted (no `text-primary`/accent), keeping it a neutral sibling.
- **Icon + label unchanged in content** — `MdReplay` (`size-3.5`) and
  `"Resumed by harness · <source>"` move verbatim from the old manual header into `label`.
- **Body unchanged** — the existing `<Text variant="caption" whitespace-pre-wrap>{e.text}</Text>`
  moves into `children`; add `break-words` to match `preprompt`'s body exactly.
- **Collapsed by default** (omit `defaultOpen`) — this matches `preprompt` so the two cards
  behave as true siblings and reduces timeline clutter. *Minor behavior change:* the old
  meta-prompt box was always-expanded; the unified card now starts collapsed behind the
  chevron. Resume prompts are short and secondary, so collapsing is the right default.

## Critical files

- **Modified:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/meta-prompt/web/components/meta-prompt-row.tsx`
- **Reference (mirror its shape):** `.../jsonl-viewer/plugins/preprompt/web/components/preprompt-row.tsx`
- **Primitive consumed (unchanged):** `.../jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx` (`CollapsibleCard`, props `label` / `className` / `children`)
- **Design system reference:** `research/2026-06-12-conversations-transcript-card-design-system.md`

## Verification

1. `./equin build` — must pass `type-check` + `eslint` (no `no-adhoc-*` regressions;
   `border-dashed`/`size-3.5` are sanctioned, the body uses the `Text` primitive).
2. Find a conversation whose transcript contains both a harness resume (loop/queue wakeup
   or "Continue from where you left off") and a launch preprompt. Screenshot via
   `e2e/screenshot.mjs --url http://att-1781266059-blue.localhost:9000/c/<id> --out /tmp/cards`.
   Confirm side-by-side:
   - **meta-prompt** renders as a muted `CollapsibleCard` with a **dashed** border, a muted
     `↺ Resumed by harness · <source>` label, a chevron, and the prompt text revealed on
     expand.
   - **preprompt** still renders as the solid primary-tinted `📣 Instructions` callout.
   - Both share the same card padding, label size (`text-2xs`), chevron, and disclosure
     behavior — they read as siblings, distinguished only by accent + icon + label.
3. Click the meta-prompt chevron in the screenshot script (`--click`) to confirm the body
   expands/collapses (it was previously always-visible).
4. Screenshot in both light and dark mode — confirm the dashed muted card stays legible and
   distinct from the solid `bg-background` user-turn panels and the primary Instructions card.
