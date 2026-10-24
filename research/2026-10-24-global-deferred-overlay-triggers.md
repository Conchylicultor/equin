# Deferred overlay triggers (Popover / DropdownMenu / Select / Dialog)

Follow-up to task-1792863059-6tl1f6 (from the conversation-open perf work, conv-1792860968-4ii96w),
which made `WithTooltip` mount base-ui's Root/Trigger only on first intent (`DeferredTrigger`).

## Context

The premise was that every closed Popover / DropdownMenu / Select / Dialog builds its base-ui Root +
Trigger at mount, multiplied by every row that carries one (row ⋯ menus, pickers, DataView item
actions), and that deferring them like tooltips would speed up conversation open and DataView group
unfold.

## Measurement (main, 2026-10-24, rate half of rate × cost)

I counted mounted closed triggers (`[data-slot=popover-trigger|dropdown-menu-trigger|select-trigger]`) after settle:

| Screen | Rows | Closed popover triggers | Closed menu triggers | Per-row? |
|---|---|---|---|---|
| Conversation `conv-1792860968-4ii96w` (/agents/c/…) | transcript | 13 | 3 | none: all header/action-bar chrome |
| /agents/tasks | 195 | 12 | 2 | none |
| /agents/all-conversations | 192 | 12 | 2 | none |
| /pages (sidebar tree) | 33 | 9 | 0 | none (tree ⋯ menu is behind row-actions' deferral) |

Why there are none per row:
- Row ⋯ menus and DataView item actions are already deferred: `row-actions` mounts its cluster only when the pointer or focus reaches the row (08a36811a6).
- The inline cell editors (`enum-editor`, `tags-editor`, which use `InlinePopover`) mount only in edit mode (`EditableCell`).
- Dialog and Sheet have no trigger consumers at all; every use is controlled.

So each screen holds about 15 instances in total, and they are persistent chrome mounted once at boot.
Opening a conversation or unfolding a group adds roughly 0 to 3 of them (the conversation header's
Artifacts, Context window and model menu).

The cases that remain genuinely per-instance are niche: date and math mentions in a page body (`InlinePopover`
per node), tag-picker rows (`tag-row-menu`), and Places tag manager rows.

**Expected gain on the two benchmarks the task names: about 0.** Per the perfs-investigation gate, the
rate does not justify the machinery for those benchmarks.

## Design (if pursued anyway: for boot chrome, page mentions and future per-row uses)

Moving the Root under a late wrapper would remount the subtree. base-ui 1.9's **detached triggers**
avoid that:
- `Popover.createHandle()` / `Menu.createHandle()`: a Trigger with a `handle` works outside any Root, through a fallback store.
- A Root with the same `handle` attaches later. Triggers migrate to it.

1. **`Popover` / `DropdownMenu` become a cheap shell.** They keep what is already outside the Root:
   - `usePopupOpenMirror` (PopupOpenScope), `useFrameFocusDismiss`, the everOpened latch, the hold context.
   - They add a gate context `{ armed, arm(), handle, rootProps }`.
   - `armed` latches true on first intent, or whenever `isOpen` is true. That covers a controlled `open` with no intent (shortcut, command, cursor-menu, search-suggestions' trigger-less anchor, exhibits/tests mounting open).
   - Payload render-function children are dropped. There are no consumers, and the type narrows.
2. **The base-ui Root moves into `PopoverContent` / `DropdownMenuContent`.**
   - While armed, the Content renders `<Primitive.Root handle {...rootProps}>` (open, onOpenChange, modal, triggerId, actionsRef, onOpenChangeComplete) around its Portal.
   - Unarmed, it renders null.
   - Submenus live inside the Content, so they are unchanged.
   - A loud runtime assert enforces at most one Content per shell (two Roots on one handle is a base-ui overlap).
3. **The Trigger generalises `DeferredTrigger`.**
   - Unarmed, it renders the element itself: `render` element, or the default `<button type="button">` around `children`. It stamps the closed-state attrs base-ui would (`data-slot`, `aria-haspopup`, `aria-expanded="false"`, `disabled`).
   - Armed, it mounts `<Primitive.Trigger handle render={bridge.render}>` as the existing no-reparent bridge does.
   - `DeferredTrigger` gains:
     - a controlled `armed` / `onArm` (the gate owns arming so the Content mounts in the same commit);
     - `onPointerDown` as a third intent (flushSync and replay). This covers a pointer already over the element when it mounts, and touch. Menu opens on pointerdown/mousedown, and the native mousedown/click that follow reach the mounted props.
   - Intents: pointerenter (flushSync), pointerdown (flushSync), focus (next commit). The first open after arming costs exactly one mount, as today.
   - `ref` and props cloned in from an outer `WithTooltip` (inline-popover, picker-pill, options-pill) merge onto the element. That is two bridge layers on one node; a test covers it.
4. **Dialog / Sheet:** the Root mounts on first `open`. `DialogTrigger` / `SheetTrigger` (0 consumers) are deleted, so a trigger whose Root never mounts cannot be spelled.
5. **Select: out of scope.** `SelectValue` inside the trigger reads the Root's `value` / `items`, and Select has no detached triggers. There are 15 uses, none per row.

Risks to verify with tests:
- **Focus guards.** base-ui renders FocusGuards around a non-modal open trigger. With the bridge they land after the element. Test Tab / Shift+Tab out of an open non-modal popover.
- **Programmatic open anchoring.** Root and Trigger mount in one commit; the Trigger registers into the fallback store and then migrates.
- **Closed-attr parity.** A test asserts the unarmed attrs equal the armed-closed attrs, minus base-ui ids and markers. e2e scripts select on `aria-expanded=false`.

Files:
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/{deferred-trigger,popover,dropdown-menu,dialog,sheet}.tsx`
- a new test `web/__tests__/overlay-deferred.test.tsx`, modelled on `tooltip-deferred.test.tsx`.

The wrappers (`InlinePopover`, `HoverPopover`, `CursorAnchoredMenu`, `ControlPanelPopover`) need no edits.

## Verification

- `./equin test plugins/primitives/plugins/css/plugins/ui-kit` covering:
  - nothing mounted while closed (`[data-base-ui-click-trigger]` absent), same node and ref;
  - first hover, pointerdown (touch), focus + Enter/ArrowDown, controlled open with no intent;
  - nested submenu, PopupOpenScope reports, PortalHost honoured, tooltip + menu on one node, focus guards.
- Plus the existing overlay suites.
- **Bench:** a new script, `ui-kit/e2e/overlay-trigger-bench.ts`. Before and after, it records:
  - mounted-trigger counts;
  - longtask blocking (sum of `duration - 50`) over an in-app conversation open;
  - a DataView group unfold (the `row-fold.ts` `--group-by` recipe).
  Run 3+ times each, on main and on this build.
