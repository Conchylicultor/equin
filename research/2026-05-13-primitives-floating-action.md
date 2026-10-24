# Floating Action Primitive

## Context

Two plugins independently implement a "hover-to-expand floating button" pattern:

- **message-toc** — pure CSS `group/toc` hover with smooth morph animation (width + max-height + bg + shadow transitions). Collapsed pill expands into a scrollable panel.
- **prompt-templates** — JS `useState` + conditional render swap. No animation at all.

Both share the same UX intent (small trigger → expand on hover → show content) but diverge in implementation quality. A new `floating-action` primitive unifies them with CSS-only hover and consistent animation.

## Design

### Compound component: 3 parts

| Component | Role |
|---|---|
| `FloatingAction` | Outer div with `group/fa`. Consumer adds positioning via `className`. |
| `FloatingActionPanel` | Morphing container: `overflow-hidden rounded-md`, border/bg/shadow/blur, CSS transition on `width, max-height, padding, background-color, box-shadow`. Consumer adds collapsed/expanded dimension classes via `group-hover/fa:`. |
| `FloatingActionFadeIn` | Delayed opacity wrapper: `opacity-0 → opacity-100` with 75ms delay, 150ms duration. |

No React context needed — the only wire between parent and children is the Tailwind group name `group/fa`.

### Panel built-in styles

```
flex overflow-hidden rounded-md
border border-border/60 backdrop-blur
bg-background/80  → group-hover/fa:bg-background/90
shadow-sm          → group-hover/fa:shadow-md
transition-[width,max-width,max-height,padding,background-color,box-shadow] duration-200 ease-out
```

Consumer controls flex direction (`flex-col`, `flex-row`, etc.) and dimensions via `className`.

### Usage pattern

```tsx
<FloatingAction className="absolute top-2 right-3 z-10">
  <FloatingActionPanel className="flex-col w-[3.25rem] group-hover/fa:w-56 max-h-[1.625rem] group-hover/fa:max-h-80">
    <div>always-visible trigger</div>
    <FloatingActionFadeIn className="min-h-0 flex-1 overflow-y-auto">
      expanded content
    </FloatingActionFadeIn>
  </FloatingActionPanel>
</FloatingAction>
```

## Files

### Create

| File | Content |
|---|---|
| `plugins/primitives/plugins/floating-action/package.json` | `@singularity/plugin-primitives-floating-action` |
| `plugins/primitives/plugins/floating-action/web/index.ts` | Barrel: re-export components + types, default PluginDefinition |
| `plugins/primitives/plugins/floating-action/web/internal/floating-action.tsx` | `FloatingAction`, `FloatingActionPanel`, `FloatingActionFadeIn` |

### Modify

| File | Change |
|---|---|
| `.../message-toc/web/components/message-toc.tsx` | Replace `group/toc` + bespoke panel with primitive components. Rename `group-hover/toc:` → `group-hover/fa:`. Wrap entry list + footer in `FloatingActionFadeIn`. |
| `.../prompt-templates/web/components/prompt-template-chips.tsx` | Remove `useState`, conditional render. Replace with `FloatingAction` + `FloatingActionPanel` + `FloatingActionFadeIn`. Icon is always visible, chips fade in. |

## Migration: message-toc

**Before** (abbreviated):
```tsx
<div className="group/toc absolute top-2 right-3 z-10">
  <div className="flex flex-col overflow-hidden rounded-md border ... transition-[...] w-[3.25rem] group-hover/toc:w-56 ...">
    <div className="... group-hover/toc:border-b ...">header</div>
    <div className="... opacity-0 group-hover/toc:opacity-100 ...">entries</div>
    <button className="... opacity-0 group-hover/toc:opacity-100 ...">scroll down</button>
  </div>
</div>
```

**After:**
```tsx
<FloatingAction className="absolute top-2 right-3 z-10">
  <FloatingActionPanel className="flex-col w-[3.25rem] group-hover/fa:w-56 max-h-[1.625rem] group-hover/fa:max-h-80">
    <div className="... group-hover/fa:border-b ...">
      <Icon /> <Count />
      <span className="... opacity-0 group-hover/fa:opacity-100">messages</span>
    </div>
    <FloatingActionFadeIn className="min-h-0 flex-1 overflow-y-auto">
      {entries.map(...)}
    </FloatingActionFadeIn>
    <FloatingActionFadeIn className="shrink-0 w-full border-t border-border/40">
      <button>scroll down</button>
    </FloatingActionFadeIn>
  </FloatingActionPanel>
</FloatingAction>
```

The inline "messages" label keeps its own `opacity-0 group-hover/fa:opacity-100` — it's a single-element detail, not worth a FadeIn wrapper.

## Migration: prompt-templates

**Before:**
```tsx
const [open, setOpen] = useState(false);
// ... conditional render: open ? chips : icon button
```

**After:**
```tsx
<FloatingAction>
  <FloatingActionPanel className="flex-row items-center gap-1 w-6 group-hover/fa:w-64 max-h-6 group-hover/fa:max-h-12 px-1 group-hover/fa:px-1.5 py-0.5 group-hover/fa:py-1">
    <PenLine className="size-3.5 shrink-0 text-muted-foreground/40 group-hover/fa:text-muted-foreground transition-colors" />
    <FloatingActionFadeIn className="flex flex-wrap items-center gap-1">
      {templates.map(chip buttons)}
    </FloatingActionFadeIn>
  </FloatingActionPanel>
</FloatingAction>
```

- No positioning class on `FloatingAction` — the `FloatingActionAnchor` in the prompt editor already provides `absolute bottom-1.5 right-1.5`.
- `flex-row` so the icon and chips sit side by side. Panel grows leftward (right-anchored by absolute positioning).
- `w-6 → w-64`: fixed expanded width since CSS transitions can't animate to `width: auto`. The exact value can be tuned visually.
- `useState` and conditional render are eliminated entirely.

## Verification

1. Run `./equin build` to register the new primitive and build.
2. Open `http://<worktree>.localhost:9000`, navigate to a conversation with messages.
3. **message-toc**: verify the pill at top-right morphs smoothly on hover — same animation as before.
4. **prompt-templates**: verify the icon at bottom-right of the prompt editor grows smoothly into chips on hover — new animation replaces the old instant swap.
5. Run `./equin check` to confirm plugin boundaries and eslint pass.
