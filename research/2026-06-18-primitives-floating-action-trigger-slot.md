# FloatingAction: a primitive-owned rigid `trigger` slot

## Context

`FloatingAction` (`plugins/primitives/plugins/floating-action/web/internal/floating-action.tsx`)
renders its `children` **opaquely** into a `flex overflow-hidden` morph panel. The
always-visible trigger and the expanding panel content are undifferentiated flex
siblings, so each consumer has to hand-negotiate space-sharing per child with raw
`shrink-0` — exactly the bug class the `Frame`/`Badge` primitives were built to
eliminate ("write the role, the primitive owns the mechanics").

When a consumer clamps the panel's main axis (e.g. `max-h-7` closed) and the panel
content is a tall flex sibling, the trigger flex-shrinks to height 0 and vanishes
silently. This already broke the prompt-templates floating pen once. The fix was a
load-bearing `shrink-0` on the trigger icon — but `shrink-0` is banned by
`layout/no-adhoc-layout`, so it had to be an `eslint-disable`, and the
no-adhoc-layout drain had stripped it as an "ad-hoc class." The hazard recurs for
every consumer, and the lint rule actively fights the only available per-site remedy.

**Intended outcome:** make "the trigger collapses to 0" *structurally
unrepresentable*. The primitive should own the collapsed footprint — the consumer
declares *which element is the trigger* (the role), never the `shrink-0` mechanic.

### Findings from exploration

- **All three consumers already place the trigger as the first child**, then the
  expanding content:
  - `prompt-templates` (`prompt-template-chips.tsx`) — trigger = `MdEdit` icon;
    panel `flex-col-reverse … max-h-7 … group-data-open/fa:max-h-56`. **The broken
    case** — carries the documented `eslint-disable … shrink-0`.
  - `message-toc` (`message-toc.tsx`) — trigger = a `<Frame>` header row; panel
    `flex-col … max-h-[1.625rem] … group-data-open/fa:max-h-80`. Also carries an
    `eslint-disable … shrink-0` on the header (plus two more disables for its
    scroll-region / footer panel-content sub-layout — see Out of scope).
  - `global-action-bar` (`global-action-bar.tsx`) — trigger = `StatusGlyph`; panel
    `items-center` (a row that grows horizontally, no main-axis clamp). Not broken,
    no disable — but conceptually identical (first child = collapsed footprint).
- **`floating-action.tsx` is already in the lint burndown allowlist**
  (`plugins/primitives/plugins/css/lint/index.ts:328`), so the primitive may use
  `shrink-0` internally **without** an `eslint-disable`.
- **The "two latent" TemplateChip icons are a false alarm — no change needed.**
  `buttonVariants` bakes `[&_svg]:shrink-0` into its base
  (`plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/button.tsx:14`).
  `MdEdit`/`MdSend` are svg descendants of `<Button>`, so they are **already rigid
  via the Button primitive**. The drain correctly removed redundant `shrink-0`;
  re-adding it would be both redundant and lint-banned. This is the same
  "fix-the-class-not-the-instance" guarantee we now want for FloatingAction's
  trigger — Button centralizes icon rigidity; FloatingAction should centralize
  trigger rigidity.

## Design

Add a **required `trigger: ReactNode` prop** to `FloatingAction`. The primitive
renders it into a primitive-owned, never-shrink wrapper, placed as the first flex
child of the panel; `children` (the expanding content) follow.

Why a required prop (vs. magic-first-child / optional / compound component):
- A required prop is the strongest structural guarantee — there is exactly one
  trigger, it always routes through the rigid wrapper, and "trigger collapses to 0"
  becomes unrepresentable. Mirrors `Frame`'s slots-as-props and `Badge`'s rigid
  `icon` slot.
- The trigger *is* the collapsed footprint — literally what the existing
  `useLayoutEffect` measures (`panelRef.getBoundingClientRect()` on mount, closed).
  Naming it `trigger` makes the contract explicit: "this child defines the rigid
  collapsed footprint."
- A "first child is special" rule would be implicit/fragile; an optional prop
  leaves the footgun loaded for the next consumer.

Behavior is otherwise **unchanged**: this only relocates the `shrink-0` from the
consumer's element into a primitive-owned wrapper. The panel stays
`flex + panelClassName`; the consumer keeps owning direction/alignment
(`flex-col` / `flex-col-reverse` / `items-center`) and the open/closed clamp
classes via `panelClassName`. Trigger-first DOM order preserves every consumer's
current visual layout (`flex-col-reverse` flips the icon to the bottom as today).

### Primitive change

`floating-action.tsx`:
- Add `trigger: ReactNode` to `FloatingActionProps` (required).
- In the panel, render the trigger inside a rigid wrapper before `children`:
  ```tsx
  <div ref={panelRef} inert={!open} className={cn("flex overflow-hidden rounded-md", …, panelClassName)}>
    <div className="shrink-0">{trigger}</div>   {/* primitive owns the rigid collapsed footprint; lint-OK (allowlisted) */}
    {children}
  </div>
  ```
  (A comment explains the `shrink-0` is the load-bearing collapsed-footprint
  guarantee, the whole point of the slot.)
- Optional but recommended: promote `floating-action.tsx` from the **burndown**
  tier to the **permanent** layout-primitive tier in
  `css/lint/index.ts` — it legitimately owns morph/positioning mechanics like the
  other layout primitives, so it should not be expected to "drain to 0." (If this
  adds noise, leave it in burndown; either way no `eslint-disable` is needed.)

### Consumer migrations (all three)

1. **`prompt-template-chips.tsx`** — move the `MdEdit` trigger icon into
   `trigger={<MdEdit … />}` and delete its `eslint-disable … shrink-0`. The `MdEdit`
   keeps its `size-3.5 text-muted-foreground/40 group-data-open/fa:… transition-colors`
   classes (no `shrink-0` — the primitive now owns it). `children` becomes just the
   `<FloatingActionFadeIn>` block.
2. **`message-toc.tsx`** — move the `<Frame>` header into `trigger={<Frame … />}`
   and delete its `shrink-0` + that `eslint-disable`. The scroll-region and footer
   `FloatingActionFadeIn`s remain as `children` (see Out of scope).
3. **`global-action-bar.tsx`** — move `<StatusGlyph status={status} />` into
   `trigger={<StatusGlyph status={status} />}`. Consistency only (not currently
   broken); aligns all consumers on one contract and documents intent.

### Docs

- Add hand-written prose to
  `plugins/primitives/plugins/floating-action/CLAUDE.md` documenting the `trigger`
  contract: it is the rigid, always-visible collapsed footprint; the primitive
  guarantees it never shrinks; expanding content goes in `children`
  (wrapped in `FloatingActionFadeIn`). The autogen reference block regenerates on
  `./equin build`.

## Critical files

- `plugins/primitives/plugins/floating-action/web/internal/floating-action.tsx` — add `trigger` slot + rigid wrapper.
- `plugins/primitives/plugins/floating-action/CLAUDE.md` — document the contract.
- `plugins/primitives/plugins/css/lint/index.ts` — (optional) move floating-action to the permanent tier.
- `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx` — migrate trigger; drop disable.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/message-toc/web/components/message-toc.tsx` — migrate header trigger; drop one disable.
- `plugins/shell/plugins/global-action-bar/web/components/global-action-bar.tsx` — migrate StatusGlyph trigger.

## Out of scope (noted follow-ups)

- **TemplateChip `MdEdit`/`MdSend` icons** — already rigid via the `Button`
  primitive's `[&_svg]:shrink-0`; no change. (The task's "latently exposed" premise
  does not hold.)
- **`message-toc`'s remaining two `eslint-disable`s** — its scroll region
  (`min-h-0 flex-1 overflow-y-auto`) and footer (`shrink-0`) are a *panel-content
  sub-layout* concern (a header/scroll/footer column inside the expanded panel),
  distinct from the trigger-collapse bug. Cleanly draining them means composing the
  panel content with `Scroll` + `Stack` primitives — a separate change.

## Verification

1. `./equin build` (runs `bun install`, type-check, eslint, boundary checks).
   - Confirms the `no-adhoc-layout` rule passes with the removed disables and the
     primitive-internal `shrink-0` (allowlisted), and that `type-check` accepts the
     now-required `trigger` prop on all three consumers.
2. Manual UI check at `http://<worktree>.localhost:9000` via `e2e/screenshot.mjs`:
   - **prompt-templates** (the regression): open a conversation, confirm the
     floating pen icon is visible **closed** (not collapsed to 0), and that hovering
     expands the template list.
     ```bash
     bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents/c/<id> --out /tmp/fa-pen
     ```
   - **message-toc**: in a conversation with several user messages, confirm the
     header count badge shows closed and the TOC expands on hover.
   - **global-action-bar**: confirm the top-right status glyph shows closed and the
     action row expands on hover (no visual regression).
3. (Optional) re-run the lint check alone to prove zero new offenders:
   `./equin check eslint`.
