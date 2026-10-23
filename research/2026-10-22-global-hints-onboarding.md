# Hints: a generic onboarding-tip system, and the first-launch flow on it

## Context

The onboarding mockup `proto-1792668692-5ijcs8` (index.html = Home, agents.html = Agent
Manager, logic in `onboard.js`, tour direction) defines how a new user meets equin:

- **Home has a short tour.** A welcome card first ("Welcome to equin", with "Show me around" and
  "I'll explore on my own"). Then the stops:
  1. app gallery
  2. toolbar ("hover it to unfold"; hovering moves the tour on)
  3. Improve ("Try it" opens Improve with a first request already filled in)
  4. the open Improve popover, with Send highlighted (sending moves on; closing goes back a step)
  5. the Agent Manager tile ("Your agent is on it", then "Open Agent Manager")
  6. inside the Agent Manager, on the row of the conversation the user just started
     ("Here's your request", or "Your request is ready" with "Open it")
- **Every way out of the tour points at `?`.** The toolbar unfolds, `?` pulses, and a toast says
  "The tour is here whenever you want it".
- **The Agent Manager has no tour, only contextual tips.** Each shows once, when its moment first
  comes, one at a time, in the order the user would use them. Acting on the target counts as "Got
  it".
  - "Try it before it ships" on the rocket, the first time a finished conversation with code is
    opened.
  - The main button's tip, worded only for the state the button is actually in.
- **The `?` help menu is the same in every app:** Replay the tour, Show tips again, Read the guide
  (`https://equin.ai/website/guide`), Ask equin how to….

None of this exists today. The explorers found no tip, tour, coachmark, spotlight or "seen once"
code anywhere in `plugins/`. Without a shared primitive, every app would hand-roll the trigger,
the seen state, the anchoring UI and the help entries. So this plan builds a generic **hints**
system first, then moves the app onto it.

## Design

### Plugin layout: a new `plugins/hints/` umbrella

| Plugin | Role |
|---|---|
| `hints` (root) | The engine: declarations, seen state, triggers, tour runner, host and shared UI. |
| `hints/plugins/help-menu` | The `?` toolbar item and its menu (an open `HelpMenu.Entry` slot). |

The concrete hints and the tour live in the plugins that own the moment (Home, improve,
open-app, push-and-exit). The engine names none of them. This is collection–consumer separation:
the engine is the collection, and contributors declare their own hints.

### 1. Declarations (`hints/core`, pure data)

```ts
defineHintAnchor(id)                // a UI target, e.g. "improve.button"
defineHintAnchor<P>(id, key: (p)=>string)   // a parameterized target, e.g. a conversation row
defineHintSignal<T>(id)             // a typed app event a tour can wait on, e.g. improve.sent {taskIds}

defineHint({ id, anchor, title, body, placement?, order? })      // contextual tip
defineTour({ id, app, intro?, steps: TourStep[], autoStart?: boolean })

TourStep = { id, anchor, title, body,                 // title/body may read the tour's data
             next?: { label, run?(ctl) } | "none",    // primary button; default "Next"
             alt?: { label, to: stepId },             // e.g. Skip
             advanceOn?: "anchor-hover" | "anchor-click" | HintSignal,
             onAnchorLost?: stepId,                   // e.g. Improve closed without sending → back
             scrim?: "dim" | "none" }
ctl = { go(stepId), next(), end(reason), data, setData, navigate(url) }
```

- Each anchor's id is exported from the core of the plugin that owns the element. For example,
  `improve/core` exports `improveButtonAnchor`, `improvePanelAnchor` and `improveSendAnchor`.
  That is how the Home tour can name another plugin's targets without deep imports.
- Registration uses two web slots: `Hints.Hint({ hint })` and `Hints.Tour({ tour })`. They follow
  the `reorder/node-types` registry pattern (slot plus read hook), with `companions: true`.

### 2. Seen state: a DB table, not config (`hints/server` and `hints/core`)

- **Why not config_v2:** it forks per worktree and never syncs back, and it resets on reload in
  browser-only hosts.
- **Model:** follow `primitives/usage-rank`, which pairs a `liveCollection` with
  `serveCollection`.
  - Table `hint_seen`, columns: `id` (hint or tour id), `outcome` (`acted | dismissed | completed |
    skipped`), `seen_at`.
  - Collection `hints.seen`: lookup by id plus a bounded window (`limit` and `maxLimit`; the set
    of hints is small).
  - Endpoints: `markHintSeen({id, outcome})` and `resetHints({ids})`. The server knows nothing
    about kinds; the client sends the ids of the declared tips or tours it wants reset.
- **Web reads:** `useHintSeen(ids)` goes through `useLive`. While that is pending, **no hint
  shows**: not-known-yet is a state to render, never a stand-in value. Without this, a tip would
  flash on every reload before the seen state arrives.
- **Room for the future tracker:** `useHintCatalog()` joins every declared hint and tour with its
  seen row, giving `{ hint, status: "seen" | "not-encountered", outcome?, seenAt? }`. A later
  "Your tips" DataView, in Settings or behind a `HelpMenu.Entry`, is a pure consumer of it. The
  plan builds the hook but not that view.
  - Recording `outcome` also lets that tracker tell "acted on it" from "dismissed it".

### 3. Anchors: ref registration, push-based

- **API:** `const ref = useHintAnchor(anchor, params?)` returns a callback ref and writes the
  element into a module-level anchor registry (subscribe plus `useSyncExternalStore`). There are
  no selectors, no polling and no MutationObserver.
- **Holding the toolbar open:** `useHintAnchor` also calls `useReportPopupOpen(isActiveAnchor)`
  (`primitives/overlay/popup-open`).
  - An anchor inside the floating action bar therefore holds the bar open while its tip or step
    shows. This uses the same counted signal the bar already obeys for its own popups.
  - It solves "unfold the toolbar" in solo mode without any new `forceOpen` API on
    `FloatingAction`.
- **Tracking the anchor:** the host follows the element's rect through the `primitives/dom` size
  and in-view helpers (the lint-sanctioned homes for ResizeObserver and IntersectionObserver).
- **Acting on the target counts:** the host listens for `pointerdown` on the active anchor. For a
  tip that marks it `acted`. For a tour step it means `advanceOn: "anchor-click"`.

### 4. Triggers

- **Contextual tip:** the owning component calls `useHintMoment(hint, when: boolean)`. When `when`
  turns true, the hint is unseen and the seen state is known, it asks the host to show it.
  - The host collects requests over a short settle window (the mockup uses about 700 ms). It
    shows the lowest-`order` request, one at a time, and the next after "Got it" or acting on the
    target.
  - Leaving the moment (`when` turns false, or the component unmounts) withdraws the request and
    hides the tip without marking it seen.
- **Tour:** `startTour(id)` / `useTours()`.
  - Tour state lives in the host at `Core.Root`, outside tab state. That lets a tour cross apps:
    the step's `ctl.navigate` uses the tabs `navigate()`.
  - `autoStart` tours start once when unseen and their `app` is focused. This applies on main
    too: its existing user sees the Home tour once after this lands. That was a user decision on
    2026-10-22.
  - A tour's id is marked seen when it starts. The recorded `outcome` is set when it ends.
- **Every tour end goes through one exit path** (finish, ×, Esc, or "I'll explore on my own"). The
  host unfolds the bar, pulses the well-known `hintsHelpAnchor` (exported from `hints/core`,
  registered by the help-menu button) and toasts "The tour is here whenever you want it — ? →
  Replay the tour".

### 5. Shared UI (`hints/web`, one host at `Core.Root`)

- **`HintHost`** renders the single active tip, or the active tour step or intro.
- **`HintCard`** has: title, body, step dots (tours), ×, an alt button, Back, and the primary
  button.
  - It is placed with `FloatingSurface` (`primitives/overlay/floating-surface`): Floating UI flip
    and scroll-follow, and no focus theft.
  - Its anchor is a virtual `{ getBoundingClientRect }` built from the anchor element plus
    padding.
- **`Spotlight`** is a dimmed scrim with a rounded cut-out, used for tour steps.
- **`Halo`** is a ring with no scrim, used for tips. Both use the `z-overlay` / `z-popover`
  layers, built on `viewport-overlay`.
- **`WelcomeCard`** is the centered intro card on a full scrim.
- **Exhibits** of `HintCard`, Spotlight and Welcome go in `hints/exhibits`, so the look can be
  reviewed standalone.
- Keyboard: Esc ends a tour, ← and → move between steps.

### 6. Help menu (`hints/plugins/help-menu`)

- **Toolbar item:** `ActionBar.Item({ id: "help" })`, a `?` icon button opening a `Popover` that
  renders `HelpMenu.Entry` contributions. The item is placed before `divider-2` in
  `config/shell/action-bar/item.jsonc`, so it sits just before Improve, as in the mockup.
- **Entries, all contributed by help-menu itself:**
  - **Replay the tour:** starts the primary tour (`defineTour({ primary: true })`). If that tour
    belongs to another app, it navigates there first; from the Agent Manager that means Home,
    matching the mockup's `restart`.
  - **Show tips again:** `resetHints(ids of every declared Hint)`, then the toast "Tips are back
    on".
  - **Read the guide:** opens `https://equin.ai/website/guide` in a new tab.
  - **Ask equin how to…:** opens a `LaunchAgentForm` (`primitives/launch`) with `textRequired` and
    a "How do I…" placeholder. It files under a new **Help** task category (`TaskCategory`, same
    pattern as `improve/core/task-category.ts`), then toasts "An agent is on it — its answer comes
    back to your queue."
- **Same menu in every app:** it is a global action-bar item, so no app can diverge.

### 7. Move the app onto it

**Improve** (`plugins/improve`):

- **Anchors:** `improveButtonAnchor` on the Improve segment; `improvePanelAnchor` and
  `improveSendAnchor` passed down to `TaskDraftPopover` / `task-draft-form` as an optional
  `hintAnchors` prop. The form stays generic.
- **Opening with a seed:** export `openImprove({ seed?: string })`. It opens the popover and seeds
  the text **only if the draft is empty**. Today `insertIntoImproveDraft` appends to the draft,
  which is wrong for a fresh first request.
- **Signal on send:** pass `onSuccess` from `ImproveButton` and `emitHintSignal(improveSent,
  { taskIds })`.

**Home** (`apps/home`):

- **Anchors:** `homeGalleryAnchor` on the `AppGrid` wrapper, and an app-tile anchor parameterized
  by app id. The tile anchor is registered through the icons view's tile render, or failing that a
  ref on the tile host; this needs checking.
- **Toolbar anchor:** `actionBarAnchor` on both action-bar hosts (`shell/global-action-bar`).
- **`homeTour` (primary, autoStart, app `home`),** with the mockup's copy:

  | Step | Anchor | Behaviour |
  |---|---|---|
  | intro | — | Welcome card. |
  | `apps` | gallery | — |
  | `bar` | action bar | `advanceOn: "anchor-hover"`. |
  | `improve` | Improve button | `next: "Try it"` runs `openImprove({ seed: FIRST_PROMPT })` then `go("ask")`; `alt: Skip → agents`. |
  | `ask` | Improve panel | Send gets the cue; `advanceOn: improveSent` stores the taskId; `onAnchorLost → improve`. |
  | `agents` | Agent Manager tile | Copy depends on whether a request was sent; `next: "Open Agent Manager"` navigates to `/agents`. |
  | `handoff` | conversation row | See below. |

  - `FIRST_PROMPT` is the mockup's default "daylight" request.
- **The handoff step:**
  - It resolves the conversation from the stored taskId through `useConversations()`
    (`row.taskId`).
  - It is anchored on `conversationRowAnchor(convId)`, which `SidebarConversationItem`
    (`conversations-view/plugins/data-view`) registers.
  - While the conversation runs: "Here's your request", with "Finish tour".
  - Once it is out of a turn: "Your request is ready", with "Open it", which opens
    `conversationPane`.
  - If no conversation exists (auto-start was off, or the user skipped sending), the tour ends at
    `agents` with the "Agent work comes back here" copy.

**Agent Manager tips:**

- **"Try it before it ships"** (`open-app`):
  - Anchored on `OpenAppButton`.
  - `useHintMoment(tryItHint, buildSucceeded && !isTurnRunning(conv))`, with `order: 1`.
- **Main-button tips** (`push-and-exit`):
  - `PushAndExitButton` registers `mainActionAnchor`.
  - `useHintMoment(hintFor(mode), finished && !provisional)`, with one hint id per state:
    `push-and-exit`, `exit` and `go`, each with `order: 2`.
  - The copy follows the mockup and the title is the button's real label ("Push & Close",
    "Close", "Go").
  - The mockup's third state, "Implement", is only in its code (`onboard.js` `act-plan`,
    `agents.html` `ACTION.plan`). Its first run never reaches it, because a request there is
    either a question or a change. The real button keeps "Go" for that state; the `go` tip
    reuses the mockup's plan text under that title.
  - States without a hint (send, queue, stop, restore…) request nothing.
  - Exporting `Mode` from `exit-mode.ts` is enough; the derivation stays where it is.
- **First-run fit:** these triggers depend only on the open conversation, never on the queue's
  other contents. They behave the same in the first-run state (one conversation, running, then
  landing in the queue) as in a busy instance. The handoff step is built against exactly that
  state.

## Critical files

- **New:** `plugins/hints/{core,server,web,exhibits}/…` and
  `plugins/hints/plugins/help-menu/{core,server,web}/…`.
- **Improve:**
  - `plugins/improve/web/components/improve-button.tsx`
  - `plugins/improve/web/internal/open-store.ts`
  - `plugins/improve/core/` (anchors and signal)
- **Task draft form:**
  - `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx`
  - `task-draft-form.tsx` (`hintAnchors` prop)
- **Home:**
  - `plugins/apps/plugins/home/plugins/app-cards/web/components/app-grid.tsx`
  - new `plugins/apps/plugins/home/plugins/tour/` (the tour declaration, so the gallery plugin
    stays tour-free)
- **Action bar:**
  - `plugins/shell/plugins/global-action-bar/web/components/global-action-bar.tsx`
  - `config/shell/action-bar/item.jsonc`
- **Agent Manager:**
  - `plugins/conversations/plugins/conversation-view/plugins/open-app/web/components/open-app-button.tsx`
  - `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx`
  - `plugins/conversations/plugins/conversations-view/plugins/data-view/web/components/sidebar-conversation-item.tsx`

## Reuse

- `FloatingSurface` and `viewport-overlay` for placement.
- `useReportPopupOpen` to hold the toolbar open.
- `liveCollection` / `serveCollection` (the usage-rank model) for the seen state.
- `defineSlot` plus a read hook (the node-types model) for the registries.
- `LaunchAgentForm` for Ask.
- `navigate` and `conversationPane` for cross-app steps.
- `showToast` for the toasts.
- `TaskCategory` for the Help category.

## Verification

1. **Unit tests** (`./singularity test plugins/hints`):
   - the tip queue: order, settle window, withdraw on leave, nothing while seen state is pending
   - the tour reducer: next, alt, onAnchorLost, signal advance, every end path firing the exit
     hook
   - the catalog join
2. **Exhibits:** `exhibit-shot.ts --id hints/card`, plus spotlight and welcome, in light and dark.
3. **E2E** `plugins/hints/e2e/first-launch.ts`, against this worktree's build:
   - reset all hints
   - load `/home`; the welcome card shows
   - walk the tour, sending the seeded request
   - assert the handoff card sits on the new conversation's row in `/agents`
   - Esc, then assert the `?` pulse and the toast
   - `?` → Replay the tour restarts it
   - Show tips again clears tip rows (checked with `query_db` on `hint_seen`)
4. **Tips, manually:** open a finished conversation with a successful build. Expect "Try it" first,
   then the main-button tip for its real state. Reopen: nothing. Use Show tips again and reopen:
   both come back.
5. **Solo mode:** the tour's `bar` and `improve` steps keep the floating toolbar unfolded.
