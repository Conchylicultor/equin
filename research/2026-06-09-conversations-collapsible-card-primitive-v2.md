# Generic CollapsibleCard primitive — shared by attachment AND tool-call cards (v2)

## Why v2

v1 introduced `CollapsibleCard` and migrated the 10 attachment/memory disclosure
cards onto it. End-to-end verification then revealed the **same nested-`<button>`
footgun in a second subsystem**: the shared `ToolCallCard` renders its `summary`
prop *inside* the trigger `<button>`, and `read`/`write`/`edit`/`multi-edit`
pass a `<FilePath>` (its own `<button>`) as that summary → 16 `button>button`
nestings observed on a single transcript.

Decision (user): **one generic primitive shared everywhere.** Generalize
`CollapsibleCard` so it is the single home for collapsible-card chrome + the
sibling/de-nesting guarantee, and rebuild `ToolCallCard` as a thin wrapper over
it. No subsystem hand-rolls a collapsible card or nests a file path again.

## Audit of the second subsystem

`ToolCallCard` (`…/jsonl-viewer/plugins/tool-call/web/components/tool-call-card.tsx`)
is consumed by 15 renderers. Only these pass an **interactive** element as
`summary` (→ nested button):

- `read/web/components/read-tool-view.tsx` — `summary = <span><FilePath/><LineRangeBadge/></span>`
- `write/web/components/write-tool-view.tsx` — `summary={<FilePath/>}`
- `edit/web/components/edit-view.tsx` — `summary={<FilePath/>}`
- `edit/web/components/multi-edit-view.tsx` — `summary={<FilePath/>}`

All other summaries (`bash`, `agent`, `skill`, `add-task`, `task-tools` ×6,
`workflow`, `ask-user-question`) are non-interactive text/badges; `add-task`'s
`LinkChip` lives in the **body**, not the summary. So the fix = move the file
path out of `summary` into a sibling slot for those four, plus the structural
guarantee in the primitive.

## Generalized `CollapsibleCard` API

`…/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx`

```tsx
export type CollapsibleCardTone = "muted" | "primary" | "tool";

export interface CollapsibleCardProps {
  /** In-trigger content after the built-in chevron (label, or badge+summary). */
  label: React.ReactNode;
  /** Convenience: render a clickable FilePath as the sibling aside. */
  filePath?: string;
  /** Sibling affordance next to (never inside) the trigger. Overrides filePath.
   *  Interactive content (FilePath, chips) MUST go here, never in `label`. */
  aside?: React.ReactNode;
  /** Far-right sibling of the header row (e.g. running-dots). */
  trailing?: React.ReactNode;
  /** Chrome scheme. Default "muted". */
  tone?: CollapsibleCardTone;
  /** Destructive chrome override (tool failures). */
  error?: boolean;
  defaultOpen?: boolean;
  className?: string;
  children?: React.ReactNode;
}
```

Per-tone config (chrome / header typography / body wrapper):

| tone | card | header (base color+size) | trigger hover | body wrapper |
|---|---|---|---|---|
| muted | `border-border/40 bg-muted/20` | `text-3xs tracking-wide text-muted-foreground` | `hover:text-foreground` | `mt-2 border-l-2 border-muted-foreground/20 pl-3` |
| primary | `border-primary/30 bg-primary/5` | `text-xs tracking-wide text-primary/80` | `hover:text-primary` | `mt-2 border-l-2 border-primary/20 pl-3` |
| tool | `border-border/60 bg-background` | `text-xs text-muted-foreground` | (none) | (none — children supply their own spacing) |

`error` (any tone) overrides card → `border-destructive/60 bg-destructive/5`.

Structure (the invariant that kills the footgun by construction):

```tsx
<div className={cn("group rounded-md border px-3 py-2", card, error && ERROR)}>
  <div className={cn("flex w-full items-center gap-2", header)}>
    <button {...triggerProps} className={cn("flex min-w-0 shrink items-center gap-2 text-left transition-colors", hover)}>
      <CollapsibleChevron open={open} className="size-3" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
    {(aside ?? (filePath && <FilePath filePath={filePath} />)) }
    {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
  </div>
  {open && (bodyWrapper ? <div id={contentId} className={bodyWrapper}>{children}</div>
                        : <div id={contentId}>{children}</div>)}
</div>
```

The trigger `<button>` only ever contains the chevron + a `label` node; all
interactive affordances (`aside`/`filePath`) are siblings. Callers cannot nest a
button because they never construct the trigger and `filePath` is a string.

### Notable UX change

Tool-call rows gain a **chevron** (the built-in disclosure affordance) and their
file path moves from inside the trigger to a sibling. Net result per Read/Edit/
Write/MultiEdit row: `⌄ [Badge] [path…] [dots]` — clicking the chevron/badge
toggles, clicking the path opens the file-peek pane (previously one ambiguous
target). This unifies every collapsible card in the transcript under one
affordance and is the only visible change to the high-traffic tool rows.

## `ToolCallCard` becomes a thin wrapper

Reimplement (same public props + one new `aside`):

```tsx
interface ToolCallCardProps { event; summary?; aside?; children?; defaultOpen?; isError?; }

export function ToolCallCard({ event, summary, aside, children, defaultOpen = false, isError }) {
  const hasError = isError ?? event.result?.isError;
  const isRunning = !event.result;
  return (
    <CollapsibleCard
      tone="tool"
      error={hasError}
      defaultOpen={defaultOpen}
      aside={aside}
      trailing={isRunning ? <RunningDots /> : undefined}
      label={
        <>
          <Badge size="sm" colorClass={hasError ? "bg-destructive/15 text-destructive" : "bg-primary/10 text-primary"} className="shrink-0 font-mono">
            {event.name || "tool_call"}
          </Badge>
          {summary && <span className="min-w-0 flex-1 truncate opacity-70">{summary}</span>}
        </>
      }
    >
      {children}
    </CollapsibleCard>
  );
}
```

`RunningDots` = the existing three-bounce-dots span, extracted locally.
tool-call plugin gains a dependency on `collapsible-card` (DAG-safe:
tool-call → collapsible-card → file-path).

### Four tool renderers move FilePath `summary` → `aside`

- `write-tool-view.tsx`: `summary={<FilePath/>}` → `aside={<FilePath/>}`.
- `edit-view.tsx`, `multi-edit-view.tsx`: same.
- `read-tool-view.tsx`: `summary={<span><FilePath/><LineRangeBadge/></span>}` →
  `aside={<span className="flex min-w-0 items-center gap-2"><FilePath/><LineRangeBadge/></span>}`.
  (`LineRangeBadge` is non-interactive; keeping it grouped with the path in the
  aside preserves the visual pairing.)

All 11 other ToolCallCard consumers are unchanged (their text summaries stay in
`label` via the `summary` prop).

## The 10 attachment/memory renderers

Unchanged — the generalization is **additive** (`label`, `filePath`, `tone`,
`defaultOpen`, `children` keep their v1 meaning). No edits needed.

## Files

**Modified**
- `…/collapsible-card/web/components/collapsible-card.tsx` (generalize)
- `…/collapsible-card/web/index.ts` (export `CollapsibleCardTone` if useful; keep barrel pure)
- `…/tool-call/web/components/tool-call-card.tsx` (rewrite as wrapper; add `aside` prop)
- `…/tool-call/plugins/read/web/components/read-tool-view.tsx`
- `…/tool-call/plugins/write/web/components/write-tool-view.tsx`
- `…/tool-call/plugins/edit/web/components/edit-view.tsx`
- `…/tool-call/plugins/edit/web/components/multi-edit-view.tsx`

**Auto-regenerated by `./equin build`** — `web.generated.ts`, CLAUDE.md/doc set.

## Verification

1. `./equin build` + `./equin check` → green (boundaries, eslint,
   registry/doc-in-sync, typescript, barrel purity).
2. Scripted Playwright on a transcript containing Read/Write/Edit AND a
   nested-memory attachment (e.g. this conversation):
   - `document.querySelectorAll("button button").length === 0` (no nested buttons
     anywhere — the whole footgun class is gone).
   - A tool row: clicking chevron/badge toggles (`aria-expanded` flips); clicking
     the path opens the file-peek pane (does not toggle).
   - A Memory card: same dual-affordance behavior (regression check of v1).
3. Visual spot-check screenshots of Read/Write/Edit rows (chevron + path sibling
   + dots) and bash/agent rows (unchanged text summary).
