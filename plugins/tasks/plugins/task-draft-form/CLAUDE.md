# task-draft-form

Reusable popover + chain form for drafting one or more tasks. Drives both the
toolbar Improve button (`plugins/improve`) and the conversation `+` button
(`plugins/conversations/.../new-child-task`).

The form is a chain of cards: index 0 is the head, each later card is blocked
by the previous one.

Each card's `options: Record<string, unknown>` holds the **launch-option** values
(auto-start model, preprompt, thinking mode, …), keyed by option id. This form
knows none of them: it renders `tasks/launch-options`' slot — the same one the
task detail's Prompt card renders — and ships the map to the chain endpoint,
which applies each value through the option's own server half. Adding a launch
setting is a plugin folder; a new field on `CardDraft` means the abstraction
leaked.

The head card honors one extra knob:

- `relate?: { taskId, defaultMode }` — adds a `prerequisite | follow-up` toggle.
  `follow-up` makes the new task wait on `relate.taskId`. `prerequisite` makes
  `relate.taskId` wait on the new task.

  The mode's extra choices live inside that Dependency menu, as checkbox rows
  that toggle without closing it: a follow-up of a task with children gets an
  "Insert before" group (one box per child, all checked by default); a
  prerequisite of a task that already has dependencies gets "Standalone —
  don't inherit existing dependencies". The form builds them as the head card's
  `DependencyExtras`; nothing about them renders under the card.

Every card carries one context toggle — **URL**, which attaches
`window.location.href` to the filed task. It is not configurable per host: every
surface that drafts a task is somewhere, and that somewhere is worth recording.
Whether the box starts checked is per-app config (`captureUrlByDefault`, read
through `useCaptureUrlDefault`).

## The draft stores choices, never defaults

Everything the user authors in the popover — the cards, both dependency modes,
Standalone, the Insert-before selection — is ONE `useDraft` record
(`TaskDraftState`), so closing the popover or reloading keeps all of it and
`resetForm` clears all of it. A new control adds a field there; a `useState`
for something the user chose is the bug this shape exists to prevent.

A default is never copied into the draft, because the draft outlives the
context that produced it (it is shared across apps, and kept for 7 days). A
card's `includeUrl` is `undefined` until the user toggles it, and follows the
open app's `captureUrlByDefault` until then; its `options` hold only the launch
options the user changed, the rest resolving to each option's `defaultValue`;
Insert-before is `undefined` (= all children) until the user unchecks one, and
the choice is keyed by the related task. All three resolve when read — on
render, and in `submitChain`, which sends every registered option.

Submits to `POST /api/tasks/chain` (handler in `plugins/tasks/server`).

## Card vs composer, and the two exhibits

A card is two layers. `TaskDraftCard` is the chain chrome: only the drag grip,
pinned to its top-right corner. The grip is the one place a drag starts (so
selecting text in the field never drags), it shows only once there are 2+ cards,
and it is always visible — dimmed until the card is hovered. A focused grip also
reorders from the keyboard (Space, ↑/↓, Space). `TaskDraftComposer` is the task
itself: the field, the URL toggle, the prose actions and the launch-option pills
— with no dnd-kit dependency, so it renders on its own.

Removing a task is not the card's job. Between two cards sits a
`ChainConnector`, a labelled row ("Then, once task 1 is done", or "In parallel —
doesn't wait for task 1" with a dashed rule) with three always-visible buttons:
link/unlink, insert a task here, and remove the task BELOW it. The first card has
no connector, so the form header's × covers it: with 2+ tasks it removes task 1
(task 2 becomes the head and takes over the head-only controls), with one task
left it closes the popover. Every task therefore has exactly one ×, and its
label says which action a click will take.

The footer holds "+ Follow-up task" (appends a card) on the left, then Cancel and
"Create task" / "Create N tasks" with its ⌘↵ hint.

The composer alone is what the plugin exhibits (`exhibits/`, an `appExhibit`
in the `plugin-meta/exhibits` catalog, id `task-draft/composer` — app, not
isolated, because its pills and prose actions are slot contributions and its
URL default is config): `exhibits/internal/composer.tsx` holds its own text /
options / URL state, starting from the same defaults, and never submits. A
prototype mocking the Improve composer compares against it with
`<meta name="mocks" content="exhibit:task-draft/composer">`.

The whole form is the second exhibit, id `task-draft/form`:
`exhibits/internal/form.tsx` renders `TaskDraftForm` (header, chain, connectors, footer) over local card
state, with the Dependency pill on as when Improve is opened from a task. Add,
reorder, link and remove all work; Create and Cancel do nothing. A prototype
mocking the Improve popover compares against it with
`<meta name="mocks" content="exhibit:task-draft/form">`.

## Inserting into a draft

Text is added two ways, and the difference is which card it lands in.

An in-form `TaskDraftFormSlots.Action` button (the element picker) is rendered on
EVERY card and writes into its own card's editor at the caret, so a chip lands in
the prose you are writing rather than jumping to the top of the chain.

An external caller has no card to speak of, so it must pick one: it goes through
the popover's insert funnel, which aims at the head card — caret insert via the
head editor's handle, or append to that card's markdown when no editor is mounted
(popover closed / form still loading). It only ever *adds*.

External callers pass `insert={draftInsert(text)}`. The request is keyed on a minted
id, not the text, so the same snippet can be inserted twice and a remount can't
re-apply one already taken. Cards are `useDraft`-persisted, so a replacing seed would
silently destroy work in progress — hence a request type rather than an `initialText`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Reusable popover + chain form for drafting one or more tasks. Powers the Improve toolbar button and the conversation new-child-task button.
- Web:
  - Slots: `TaskDraftFormSlots.Action`
  - Slot contributors: `TaskDraftFormSlots.Action` ← `improve.element-picker`
  - Contributes: `ConfigV2.WebRegister` "config"
  - Uses: 42 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `tasks/launch-options` ×5
    - `primitives/css/ui-kit` ×3
    - `primitives/persistent-draft` ×3
    - `primitives/sortable-list` ×3
    - `primitives/text-editor/composer` ×3
    - `config_v2` ×2
    - `infra/endpoints` ×2
    - `primitives/overlay/tooltip` ×2
    - `primitives/shortcuts` ×2
    - `apps-core.useCurrentAppId`
    - `network/live.useLive`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/icon-button.IconButton`
    - `primitives/live-state.ResourceView`
    - `primitives/loading.Loading`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/slot-render.defineRenderSlot`
    - `primitives/text-editor/composer/picker-pill.PickerPill`
    - `primitives/text-editor/paste-images.extractAttachmentIds`
    - `shell/notifications.toast`
    - `ui/icons.Icon`
  - Exports (types):
    - `ActiveRelateContext`
    - `CardDraft`
    - `TaskDraftActionProps`
    - `TaskDraftInsert`
    - `TaskDraftPopoverProps`
    - `TaskDraftRelate`
  - Exports (values):
    - `draftInsert`
    - `setActiveRelateContext`
    - `TaskDraftFormSlots`
    - `TaskDraftPopover`
    - `useActiveRelateContext`
- Server:
  - Contributes: `ConfigV2.Register` "config"
  - Uses: `config_v2.ConfigV2`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary-foreground`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shadow --shadow-lg`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by:
    - `conversations/conversation-view`
    - `conversations/conversation-view/new-child-task`
    - `improve`
    - `improve/element-picker`
    - `tasks/task-dependencies`
- Core:
  - Exports (values): `TASK_DRAFT_FORM_WIDTH`

<!-- AUTOGENERATED:END -->
