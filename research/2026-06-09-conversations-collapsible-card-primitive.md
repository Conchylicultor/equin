# Collapsible disclosure-card primitive for the JSONL viewer

## Context

Several JSONL-viewer renderers build a collapsible "disclosure card" by hand:
a bordered card whose header is a `<button {...triggerProps}>` (chevron + label)
and whose body is a left-bordered content region. One of them —
`nested-memory` — places a clickable `<FilePath>` (which renders its **own**
`<button>`) *inside* that trigger button:

```tsx
// nested-memory-attachment-view.tsx — BROKEN
<button {...triggerProps} className="flex w-full items-center gap-2 …">
  <CollapsibleChevron open={open} className="size-3" />
  <FilePath filePath={att.path} />   {/* <button> nested in <button> */}
</button>
```

This is invalid HTML (`<button>` cannot contain a `<button>`): React emits a
hydration warning, and because the file path dominates the row width, clicking
the row usually opens the file-peek pane instead of toggling the collapsible —
an ambiguous, two-affordances-in-one click target.

`edited-text-file` already works around this **locally** by splitting the row
into a `<div>` whose direct children are two siblings — the trigger `<button>`
and the `<FilePath>`. But that correct layout is re-derived by hand, so the next
renderer is free to nest again. The same hand-rolled card shell is duplicated
across **ten** renderers, which is both the duplication smell and the reason the
footgun keeps being reachable.

**Goal:** eliminate the footgun *by construction* — introduce one
`CollapsibleCard` primitive that owns the card chrome, the chevron trigger, the
collapsible body, and (when given a path) renders the `<FilePath>` as a
guaranteed sibling of the trigger. No renderer hand-rolls a trigger button
anymore, so a `<button>` can never again be nested inside one. Migrate all ten
disclosure-card renderers onto it.

## Audit (full set of affected renderers)

All live under
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/`.
Every one of these currently hand-rolls the identical shell
(`rounded-md border … bg-… px-3 py-2` → `<button {...triggerProps}>` chevron +
label → `{open && <div … border-l-2 … pl-3>}`):

| Renderer | File | FilePath? | Tone |
|---|---|---|---|
| **nested-memory** (the bug) | `attachment/plugins/nested-memory/web/components/nested-memory-attachment-view.tsx` | yes (`att.path`) | muted |
| edited-text-file (already split) | `attachment/plugins/edited-text-file/web/components/edited-text-file-view.tsx` | yes (`att.filename`) | muted |
| skill-listing | `attachment/plugins/skill-listing/web/components/skill-listing-view.tsx` | no | muted |
| task-reminder | `attachment/plugins/task-reminder/web/components/task-reminder-attachment-view.tsx` | no | muted |
| command-permissions | `attachment/plugins/command-permissions/web/components/command-permissions-view.tsx` | no | muted |
| deferred-tools-delta | `attachment/plugins/deferred-tools-delta/web/components/deferred-tools-delta-view.tsx` | no | muted |
| generic-attachment (fallback) | `attachment/web/components/generic-attachment-view.tsx` | no | muted |
| assistant-thinking | `assistant-thinking/web/components/assistant-thinking-row.tsx` | no | muted |
| unknown | `unknown/web/components/unknown-row.tsx` | no | muted |
| preprompt | `preprompt/web/components/preprompt-row.tsx` | no | **primary** (`border-primary/30 bg-primary/5`, `text-xs`, primary text, `MdCampaign` icon) |

Only `nested-memory` has the live nested-button bug. The rest are migrated to
kill the duplication and remove the hand-rolled trigger pattern entirely
(per-user decision: migrate **all ten**, including the primary-toned
`preprompt`, so zero hand-rolled triggers remain).

Note: `text-3xs` (= `0.625rem` = 10px, defined in
`plugins/framework/plugins/web-core/web/theme/app.css`) is identical in size to
the ad-hoc `text-[10px]` used by most renderers, so standardizing the trigger on
`text-3xs` is a pure token cleanup with no visual change.

## Design

### New plugin: `collapsible-card`

A new JSONL-viewer sub-plugin (sibling of `file-path`, `attachment`, etc.):

```
plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/
  package.json
  web/
    index.ts                       # barrel: export CollapsibleCard + type, default PluginDefinition
    components/
      collapsible-card.tsx
```

It must live *inside* the jsonl-viewer subtree (not under `primitives/`) because
it depends on `FilePath`, which is jsonl-viewer-specific (coupled to
`conversationPane` and the file-peek pane). Dependency direction stays a DAG:
renderers → `collapsible-card` → `file-path` + `primitives/collapsible`. The
plugin is auto-discovered and `dependsOn` is auto-derived by `./equin
build` (regenerates `web.generated.ts`) — no manual registry edit. It mirrors
the component-only `file-path` plugin (`contributions: []`, components in
`web/components/`).

### Component API

```tsx
interface CollapsibleCardProps {
  /** Trigger content beside the chevron. Caller controls font/icon markup
   *  (e.g. font-mono, a leading <MdCampaign/>). Natural case — never all-caps
   *  (jsonl-viewer rule). */
  label: React.ReactNode;
  /** Optional clickable file path. Rendered as a sibling of the trigger button
   *  (never nested) — this is the structural guarantee. */
  filePath?: string;
  /** Visual scheme. "muted" (default) = the standard grey card;
   *  "primary" = the prominent callout used by preprompt. */
  tone?: "muted" | "primary";
  /** Open on first render. Default false. */
  defaultOpen?: boolean;
  /** Collapsible body. Callers provide their own inner text styling. */
  children: React.ReactNode;
}
```

Implementation (mirrors the corrected `edited-text-file` sibling layout exactly):

```tsx
const TONE = {
  muted: {
    card: "border-border/40 bg-muted/20",
    trigger: "text-3xs text-muted-foreground hover:text-foreground",
    content: "border-muted-foreground/20",
  },
  primary: {
    card: "border-primary/30 bg-primary/5",
    trigger: "text-xs text-primary/80 hover:text-primary",
    content: "border-primary/20",
  },
} as const;

export function CollapsibleCard({ label, filePath, tone = "muted", defaultOpen, children }: CollapsibleCardProps) {
  const { open, triggerProps, contentId } = useCollapsible({ defaultOpen });
  const t = TONE[tone];
  return (
    <div className={cn("rounded-md border px-3 py-2", t.card)}>
      <div className={cn("flex w-full items-center gap-2 tracking-wide", t.trigger)}>
        <button
          {...triggerProps}
          className="flex min-w-0 shrink items-center gap-2 text-left transition-colors hover:[color:inherit]"
        >
          <CollapsibleChevron open={open} className="size-3" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
        {filePath && <FilePath filePath={filePath} />}
      </div>
      {open && (
        <div id={contentId} className={cn("mt-2 border-l-2 pl-3", t.content)}>
          {children}
        </div>
      )}
    </div>
  );
}
```

Key structural points:
- The header is a **`<div>`**; the trigger `<button>` and the `<FilePath>`
  button are siblings inside it. Nesting is impossible because callers never
  construct the trigger.
- `filePath` is a **string**, not a node — callers can't hand it a `<button>`,
  so the single-affordance layout is guaranteed.
- `min-w-0 shrink` + `truncate` on the trigger keeps a long label from pushing
  the file path off-row (the trigger yields, the path keeps its own ellipsis).
- The hover color is unified across tones via `hover:[color:inherit]` from the
  tone-colored wrapper. (If `cn` is unavailable in this subtree, inline the
  class strings; verify which `cn`/`clsx` helper neighboring components import.)

### Per-renderer migration

Each renderer collapses to a single `<CollapsibleCard>` with its body as
children. Examples:

```tsx
// nested-memory — THE FIX
<CollapsibleCard label="Memory" filePath={att.path}>
  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground leading-5">
    {att.content?.content ?? JSON.stringify(att, null, 2)}
  </pre>
</CollapsibleCard>
```

```tsx
// edited-text-file
<CollapsibleCard label="Edited file" filePath={att.filename}>
  <CodeWithLineNumbers content={att.snippet ?? ""} filePath={att.filename} />
</CollapsibleCard>
```

```tsx
// skill-listing (font-mono label, count)
<CollapsibleCard label={<span className="font-mono">Skills Available <span className="text-muted-foreground/60">({count})</span></span>}>
  …existing <ul>…
</CollapsibleCard>
```

```tsx
// preprompt — primary tone, icon folded into label
<CollapsibleCard
  tone="primary"
  label={<><MdCampaign className="size-3.5" /><span>Instructions</span></>}
>
  <div className="whitespace-pre-wrap break-words text-xs text-muted-foreground leading-5">{e.text}</div>
</CollapsibleCard>
```

For `assistant-thinking`/`unknown` (text styling currently on the content
`<div>`): move that styling onto a child wrapper the caller passes, since the
primitive owns only the structural `mt-2 border-l-2 pl-3` content region.

`label` semantics preserved from each original (`Edited file`, `Skills
Available (N)`, `Task Reminder (N tasks)`, `Command Permissions (N)`, `Tools
Delta (…)`, `attachment:<subtype>`, `<unknown type>`, `Thinking`,
`Instructions`). The one new copy is **`nested-memory`'s label "Memory"** — it
previously had no separate label (the file path *was* the trigger); it now gets
a short natural-case eyebrow beside the chevron, reading `⌄ Memory  <path>`,
consistent with `edited-text-file`'s `⌄ Edited file  <path>`.

## Files

**New**
- `…/jsonl-viewer/plugins/collapsible-card/package.json`
- `…/jsonl-viewer/plugins/collapsible-card/web/index.ts`
- `…/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx`

**Modified (migrate to `CollapsibleCard`)**
- `…/attachment/plugins/nested-memory/web/components/nested-memory-attachment-view.tsx` (the fix)
- `…/attachment/plugins/edited-text-file/web/components/edited-text-file-view.tsx`
- `…/attachment/plugins/skill-listing/web/components/skill-listing-view.tsx`
- `…/attachment/plugins/task-reminder/web/components/task-reminder-attachment-view.tsx`
- `…/attachment/plugins/command-permissions/web/components/command-permissions-view.tsx`
- `…/attachment/plugins/deferred-tools-delta/web/components/deferred-tools-delta-view.tsx`
- `…/attachment/web/components/generic-attachment-view.tsx`
- `…/assistant-thinking/web/components/assistant-thinking-row.tsx`
- `…/unknown/web/components/unknown-row.tsx`
- `…/preprompt/web/components/preprompt-row.tsx`

**Auto-regenerated by `./equin build`** (do not hand-edit)
- `plugins/framework/plugins/web-sdk/core/web.generated.ts` (new plugin entry + `dependsOn`)
- `collapsible-card/CLAUDE.md` and the `docs/plugins-*.md` doc set

## Implementation notes / constraints

- `useCollapsible`, `CollapsibleChevron` from
  `@plugins/primitives/plugins/collapsible/web`; `FilePath` from
  `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web`.
- Barrel purity: `web/index.ts` only re-exports the component + its type and the
  single `default … satisfies PluginDefinition` (`contributions: []`).
- No all-caps labels; no inline timestamps (both jsonl-viewer rules already
  satisfied since labels are natural-case and no timestamp is added).
- Confirm the `cn`/`clsx` helper used by sibling components and reuse it; do not
  introduce a new classname utility.

## Verification

1. `./equin build` from the worktree (regenerates registry + docs, runs
   checks, restarts server). Must pass `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, `eslint`, and `plugin-boundaries`.
2. `./equin check` — expect green (boundaries, barrel purity, docs).
3. Open a conversation whose transcript contains a **nested-memory** attachment
   (a loaded `CLAUDE.md`) at `http://<worktree>.localhost:9000` and, scripted
   with `bun e2e/screenshot.mjs`:
   - Clicking the **label / chevron** toggles the card (open/close), and
   - Clicking the **file path** opens the file-peek pane (does *not* toggle),
   confirming the two affordances are now distinct.
4. Open the browser console / check `~/.singularity/worktrees/<wt>/logs/*.jsonl`
   for the absence of the React "validateDOMNesting … `<button>` cannot appear
   as a descendant of `<button>`" hydration warning that the old nested-memory
   row produced.
5. Spot-check the other migrated renderers (thinking, preprompt, skill-listing,
   task-reminder, generic/unknown) render and toggle identically to before
   (preprompt retains its primary tone, larger text, and campaign icon).
