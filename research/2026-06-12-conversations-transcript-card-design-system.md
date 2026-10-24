# Transcript Card Design System

_2026-06-12 · jsonl-viewer / collapsible-card_

## Context

The jsonl-viewer transcript renders cards through a single shared `CollapsibleCard`
structure, but that component carries **three divergent chrome "tones"** (`muted`,
`primary`, `tool`) that were each a family's pre-existing styling. Side by side the
families read as inconsistent:

| | muted (thinking, memory, attachments, unknown) | primary (Instructions) | tool (all tool calls) |
|---|---|---|---|
| label font | `text-3xs` (10px) | `text-xs` (12px) | `text-xs` (12px) |
| fill | `bg-muted/20` | `bg-primary/5` | `bg-background` |
| border | `border-border/40` | `border-primary/30` | `border-border/60` |
| label | plain muted text | primary icon+text | primary mono **Badge** |
| body | left-border indent | left-border indent | flat |

Different font sizes, fills, borders, accent treatment, and (because the muted
label is 10px while a tool card's FilePath aside is `text-2xs`/11px) different row
heights. Unifying the card *structure* surfaced the styling mismatch.

This plan defines **one canonical card chrome** and a **single color language**,
collapsing the three tones into uniform chrome + a small set of sanctioned
semantic accents.

Side note discovered during research: `text-xs` is actually banned by the
`no-adhoc-typography` lint rule; it only slips through today because it lives in a
plain object literal (`TONE`) rather than a `className`/`cn()` argument. The
canonical font must come from the sanctioned sub-scale (`text-3xs`/`text-2xs`).

## Decision: canonical card

**Chrome — identical for every card** (the three-tone map is deleted):

- Fill: `bg-muted/20`
- Border: `border-border/50`
- Padding: `px-3 py-2` (unchanged)
- Header label: **`text-2xs` (11px)**, `text-muted-foreground`, `hover:text-foreground`
  - Anchored to `text-2xs` because the `FilePath` aside is already `text-2xs`
    (`plugins/.../file-path/web/components/file-path.tsx:44`). Matching them gives a
    **uniform row height** for every card, including Read/Edit/Write cards whose
    height was previously driven by the larger aside. This resolves the
    "context-driven sizing / file-path row height" concern: the row height is now a
    single intrinsic value, not a per-family accident.
- Body: flat `mt-2` (the per-tone left-border indent is dropped — tool bodies render
  diffs/code/outputs that bring their own structure, and a `border-l-2 pl-3` wrapper
  double-nests them; text bodies read fine with top spacing alone).

**Color language — "Tool-identity accent"** (chosen by user). Color is spent on
exactly three sanctioned semantic accents; everything else is muted:

1. **Tool identity → primary chip.** Tool/skill name renders as a primary-tinted
   mono `Badge` (`bg-primary/10 text-primary`, `size="sm"` = `text-3xs`). Unchanged
   from today — this is the deliberate per-row accent that marks a tool invocation.
2. **Error → destructive chrome.** `error` boolean keeps the red card override
   (`border-destructive/60 bg-destructive/5`) and the tool chip flips to
   `bg-destructive/15 text-destructive`. Unchanged.
3. **Primary callout → Instructions.** The preprompt "Instructions" card keeps a
   primary leading icon + primary label, and retains a subtle primary chrome tint
   (`border-primary/30 bg-primary/5`) — but expressed at the call site via the
   generic `className` override, **not** via a `tone` enum. It is the single
   sanctioned callout, mirroring how `error` recolors chrome, rather than a
   competing family.

Section cards (Thinking, Memory, Edited file, Skills Available, Command
Permissions, Task Reminder, Tools Delta, generic attachment, unknown) stay **plain
muted labels** — no chip. They inherit the new 11px uniform sizing automatically.

### Transcript hierarchy: user turns vs detail cards

With tool cards moving off `bg-background` onto the recessive `bg-muted/20` tint,
that solid border-defined "panel" treatment is freed up — and is the right identity
for **user turns**, which today share the muted-tint language with collapsible cards
(`bg-muted/40`) and so read as just another card. Re-tiering:

| Tier | Members | Treatment |
|---|---|---|
| **User turns** (anchors) | `user-text`, `user-image` | `bg-background` + `border-border/60` + `rounded-md` — crisp, border-defined panels (the old tool-card look) |
| **Collapsible detail cards** | tools, thinking, attachments, unknown | `bg-muted/20` + `border-border/50` — recessive faint tint |
| **Assistant prose** | `assistant-text` | flat, no chrome |
| **Harness-injected** | `meta-prompt` | `bg-muted/30` + **dashed** border (unchanged — deliberately "not human") |

User turns become clean panels defined by a heavier `/60` border rather than by
tint, set apart from the faintly-tinted machine cards. Because `bg-background`
matches the page fill, the border does the work (in dark mode they read as a clean
cutout, not a raised block); the heavier border + `variant="body"` prose keep them
substantial. If a turn recedes too far in either theme, the neutral fallback is a
stronger border or a thin neutral left accent — **not** primary (reserved for tool
identity + the Instructions callout).

## Implementation

### 1. Collapse the tone map — `collapsible-card/web/components/collapsible-card.tsx`

- Delete the `TONE` constant and the `CollapsibleCardTone` type + `tone` prop.
- Render one uniform chrome. Header row className becomes
  `relative flex w-full items-center gap-2 text-2xs text-muted-foreground hover:text-foreground`.
- Card className: `cn("group px-3 py-2", error ? ERROR_CARD : "border-border/50 bg-muted/20", className)`
  — `error` still wins; caller `className` (used by Instructions) merges over the
  base via `twMerge`/`cn` so `border-primary/30 bg-primary/5` overrides cleanly.
- Body: always `<div id={contentId} className="mt-2">{children}</div>` (drop the
  `t.body ?` branch).
- Update the barrel/JSDoc; the doc-in-sync `CLAUDE.md` line ("in muted or primary
  tone") is regenerated by `./equin build`.

### 2. Tool cards — `tool-call/web/components/tool-call-card.tsx`

- Remove `tone="tool"` (now the default uniform chrome). Badge color logic and
  `error` derivation are unchanged — the primary tool chip is retained per the
  chosen accent model. **Single consumer = all tool renderers update at once.**

### 3. Instructions callout — `preprompt/web/components/preprompt-row.tsx`

- Remove `tone="primary"`.
- Wrap the label in primary color: `<span className="flex items-center gap-1.5 text-primary"><MdCampaign className="size-3.5" />Instructions</span>`.
- Pass `className="border-primary/30 bg-primary/5"` to keep the subtle callout tint.

### 4. User turns — adopt the freed-up panel treatment

- `user-text/web/components/user-text-row.tsx` (container ~line 98) and
  `user-image/web/components/user-image-row.tsx` (~line 12): change `bg-muted/40` →
  `bg-background`, keeping `border border-border/60 rounded-md px-3 py-2`. These stay
  custom divs (they are not `CollapsibleCard`s), just retoned for the new hierarchy.
- Leave `meta-prompt` (dashed `bg-muted/30`) and `assistant-text` (flat) unchanged.

### 5. Muted-family consumers — no change required

These already omit `tone` (relied on the `"muted"` default), so they need **zero
edits**; they inherit the new uniform chrome and 11px sizing automatically:
`assistant-thinking-row.tsx`, `nested-memory-*`, `edited-text-file-view.tsx`,
`skill-listing-view.tsx`, `command-permissions-view.tsx`,
`task-reminder-attachment-view.tsx`, `deferred-tools-delta-view.tsx`,
`generic-attachment-view.tsx`, `unknown-row.tsx`. (Verify none import the removed
`CollapsibleCardTone` type — grep before building.)

## Critical files

- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx` — the tone map lives here
- `.../jsonl-viewer/plugins/tool-call/web/components/tool-call-card.tsx` — shared tool wrapper
- `.../jsonl-viewer/plugins/preprompt/web/components/preprompt-row.tsx` — the one primary callout
- `.../jsonl-viewer/plugins/file-path/web/components/file-path.tsx:44` — `text-2xs` anchor (read-only reference)

## Verification

1. `./equin build` — must pass `type-check` + `eslint` (confirms no `text-xs`
   regression, no dangling `CollapsibleCardTone` import).
2. Open a conversation with a rich transcript and screenshot via `e2e/screenshot.mjs`
   (`--url http://<worktree>.localhost:9000/c/<id>`). Confirm side-by-side:
   - Thinking / Memory / attachment cards and tool-call cards share the same fill,
     border, label size, and row height.
   - Tool cards keep the primary name chip; an errored tool card shows red chrome +
     red chip.
   - The Instructions card shows the primary icon+label + subtle primary tint.
   - **User turns** read as crisp border-defined `bg-background` panels, clearly
     distinct from the faint `bg-muted/20` collapsible cards.
3. Spot-check a Read/Edit card (FilePath aside) — header label and file path sit on
   the same baseline at the same size; row height matches a plain section card.
4. Screenshot in **both light and dark mode** (toggle theme) — confirm user turns
   still read as anchors in dark mode (where `bg-background` is the darkest fill);
   if they recede, apply the neutral-border/left-accent fallback.

## Notes / tradeoffs

- **Dropped the left-border body indent** for a flat `mt-2`. Trade: text disclosures
  (thinking/memory) lose a faint left rail; gain: no double-nesting around tool diff
  containers and one uniform body rule. Reversible if the rail is missed.
- **Instructions chrome via `className`, not a tone enum.** Keeps chrome decisions
  uniform-by-default with one explicit opt-in for the sanctioned callout, instead of
  a parallel styling family. Same pattern the `error` accent already uses.
- **`tone` prop fully removed** rather than repurposed — chrome is now decoupled from
  accent (accent lives in label content + `error` + the callout className), which is
  the structural fix that prevents a third family from silently reappearing.
