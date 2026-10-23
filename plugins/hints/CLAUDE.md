# hints

The generic onboarding-tip engine: **contextual tips** (shown once, at their
moment, one at a time) and **tours** (a welcome card plus spotlit steps, able to
cross apps), with the seen state they share and the one host that draws them.
Plan: [`research/2026-10-22-global-hints-onboarding.md`](../../research/2026-10-22-global-hints-onboarding.md).

The engine names no hint. Each hint, tour, anchor and signal is declared by the
plugin that owns the moment (collection–consumer separation): the engine is
the collection.

## The pieces

| Concept | Declared with (`hints/core`) | Used with (`hints/web`) |
|---|---|---|
| Anchor — a UI target | `defineHintAnchor(id)`, or `defineHintAnchor(id, (p) => key)` for a family (`family.at(p)`) | `const ref = useHintAnchor(target)` on the element |
| Signal — a typed app event | `defineHintSignal<T>(id)` | `emitHintSignal(signal, payload)` |
| Tip | `defineHint({ id, anchor, title, body, placement?, order?, gotIt? })` | `Hints.Hint({ hint })` + `useHintMoment(hint, when)` |
| Tour | `defineTour({ id, app, primary?, autoStart?, intro?, initialData, steps })` | `Hints.Tour({ tour })` + `startTour(id)` |
| Seen state | `hintsSeen` (live collection), `markHintSeenEndpoint`, `resetHintsEndpoint` | `useHintSeen()`, `useResetHints()`, `useHintCatalog()` |

- **Anchors live in the owner's `core/`** (`improve/core` exports
  `improveButtonAnchor`), so another plugin's tour names them without a deep
  import. `hintsHelpAnchor` (this plugin) is the `?` help button's.
- **Copy is `ReactNode`** (`HintContent`), and a tour's copy and labels may be
  functions of the tour's data. `core/` only names React's *types*; the web
  host renders them.
- **Ids are one namespace**: a hint id and a tour id are both seen-row ids.

## A contextual tip

```tsx
// open-app/core — the anchor and the tip are data
export const openAppAnchor = defineHintAnchor("open-app.button");
export const tryItHint = defineHint({
  id: "open-app.try-it",
  anchor: openAppAnchor,
  title: "Try it before it ships",
  body: "Open the agent's build and check the change works before you push.",
  order: 1,
});

// open-app/web/index.ts — declare it (catalog, "Show tips again")
contributions: [Hints.Hint({ hint: tryItHint })]

// the component that owns the moment
function OpenAppButton({ conv }) {
  const anchorRef = useHintAnchor(openAppAnchor);
  useHintMoment(tryItHint, buildSucceeded && !isAgentBusy(conv.status));
  return <Button ref={anchorRef} …/>;
}
```

`useHintMoment(hint, when)`: while `when` holds the tip is *requested*. The
host shows it when the seen state is **known** and has no row for it, it was
not answered this session, its anchor is on the page **and on screen** (one
page-wide in-view watcher; scrolled away, the tip hides and comes back when the
anchor does) and no tour runs. Requests
are collected over a **700 ms settle window**, then the lowest `order` (ties:
first asked) shows — one at a time; the next gets a fresh window after an
answer. `when` → false or unmount **withdraws** it without marking it seen.
Several components may hold one hint's moment (every prototype chip on the
page): the request stays until the last of them lets go. `hint` may be
`undefined` — a generic component handed an optional tip asks nothing (id-chip's
`idChip({ …, hint })` is one: its chips anchor and request the kind's tip).
"Got it" / × marks `dismissed`; a `pointerdown` on the anchor marks `acted`.
While the seen state is pending nothing shows (no flash on reload).

## A tour

```tsx
// improve/core
export const improveSent = defineHintSignal<{ taskIds: string[] }>("improve.sent");

// home/tour/core
export const homeTour = defineTour<{ taskId?: string }>({
  id: "home.tour",
  app: homeApp,
  primary: true,     // "Replay the tour" starts it
  autoStart: true,   // once, the first time Home is focused while unseen
  intro: { title: "Welcome to equin", body: "…" },   // start / skip labels default
  initialData: {},
  steps: [
    { id: "apps", anchor: homeGalleryAnchor, title: "Your apps", body: "…" },
    { id: "bar", anchor: actionBarAnchor, title: "The toolbar", body: "Hover it to unfold",
      advanceOn: "anchor-hover" },
    { id: "improve", anchor: improveButtonAnchor, title: "Improve anything", body: "…",
      next: { label: "Try it", run: (ctl) => { openImprove({ seed: FIRST_PROMPT }); ctl.go("ask"); } },
      alt: { label: "Skip", to: "agents" } },
    { id: "ask", anchor: improvePanelAnchor, cue: improveSendAnchor, title: "Send it", body: "…",
      next: "none", onAnchorLost: "improve",
      advanceOn: onSignal(improveSent, { update: (d, p) => ({ ...d, taskId: p.taskIds[0] }) }) },
    { id: "agents", anchor: appTileAnchor.at("agent-manager"),
      title: (d) => (d.taskId ? "Your agent is on it" : "Agent work comes back here"), body: "…",
      next: { label: "Open Agent Manager", run: (ctl) => { ctl.navigate("/agents"); ctl.next(); } } },
    { id: "handoff", anchor: (d) => (d.conversationId ? conversationRowAnchor.at(d.conversationId) : null), … },
  ],
});

// home/tour/web/index.ts
contributions: [Hints.Tour({ tour: homeTour, companion: true })]
```

- **Steps**: `next` (default "Next" / "Done" on the last; `run(ctl)` replaces
  the move — call `ctl.next()` / `go()` / `end()` yourself; `"none"` hides the
  button), `alt: { label, to }`, `advanceOn` (`"anchor-hover"`,
  `"anchor-click"`, a signal, or `onSignal(signal, { update?, to? })` to fold
  the payload into the data; or a gesture as a function of the data,
  `(d) => "anchor-hover" | "anchor-click" | null`, for an anchor whose gesture
  only means something in some states), `onAnchorLost: stepId`, `scrim: "dim" | "none"`,
  `cue` (a second element ringed), `placement`, `back` (a step id: Back
  jumps there, rewinding the history to before its last visit; `null`: no
  Back; default: the step the tour came from).
- **Anchor `null`** (or a data function returning null) draws the card
  centered with no spotlight. An anchor **not on the page yet** draws nothing
  — the step waits for it (a row that appears after navigating). Only an
  anchor that was shown and then left counts as lost.
  A step that lands on a target not fully on screen (a row below the
  sidebar's fold) scrolls it into view, centered (`scroll-reveal`) — once per
  step and element, never on data churn.
- **`ctl`** = `{ via, go, next, end(outcome?), data, setData(patch | fn), navigate(url) }`;
  `navigate` is apps-core's tabs `navigate()`.
- **A gesture is the primary, done by hand.** `advanceOn: "anchor-click"` /
  `"anchor-hover"` means the user acted on the target themselves, so it does
  exactly what the primary button does — `next.run(ctl)` with
  `ctl.via === "anchor"` (the button says `"button"`), else the default move.
  The click is heard on the document **after** the anchor's own handlers
  (a `click`, so keyboard activation counts), so the run builds on what the
  anchor did instead of racing it: Improve's step declares `"anchor-click"`
  and its "Try it" run (`openImprove({ seed })`, `ctl.go("ask")`) seeds the
  popover the click just opened. A run whose action IS the anchor's own
  (the handoff opening the row the user clicked) skips it on `via: "anchor"`.
  The decision is the pure `primaryMove(run, press)` in `tour-machine.ts`.
- **Data from outside the steps**: `useTourRun(tour)` reads `{ phase,
  stepId, data }` while that tour runs (else `null`), `setTourData(tour,
  update)` writes it — for data only the page knows (Home's tour resolves the
  handoff conversation in a `Core.Root` tracker mounted by its own plugin).
- **`startTour(id)`**: navigates to the tour's `app.basePath` first if another
  app is focused. A running tour ends (`dismissed`) before a new one starts.
- **Seen**: the tour id is marked seen (outcome null) when it **starts**; the
  outcome (`completed` / `skipped` / `dismissed`) lands when it ends.
- **Keys**: Esc ends (`dismissed`), → presses the primary (not on a
  `next: "none"` step), ← goes back — `defineShortcut`s gated on a running
  tour, priority 10 (above solo mode's Esc).

### The one exit path

Every tour end — finishing, ×, Esc, "I'll explore on my own" — goes through
the host's single exit: mark the outcome, **pulse `hintsHelpAnchor` for 3 s**,
and toast "The tour is here whenever you want it — ? in the toolbar → Replay
the tour". The pulse is a state the anchor's owner reads:

```tsx
const ref = useHintAnchor(hintsHelpAnchor);
const pulsing = useHintAnchorPulse(hintsHelpAnchor);   // draw a ring while true
```

## Anchors, holding the toolbar open

`useHintAnchor(target)` (target may be `null`/`undefined` — a generic
component handed an optional anchor registers nothing) returns a callback ref that writes the element into a
page-global registry (push-based, `useSyncExternalStore`; no selectors,
polling or MutationObserver). Several elements may register one key (a
keep-alive tab's hidden copy, the action bar's two hosts): the newest one that
is actually rendered (`checkVisibility`) wins, re-resolved on registration
changes, focused-app changes, and **whenever a registered element starts or
stops being rendered** — one page-wide `ResizeObserver` watches every
registered element, since a `display` flip on it or an ancestor changes its
box. That is what makes an element registered ONCE and then hidden / shown
in place work: Improve's popover keeps its draft form mounted while closed, so
opening it ("Try it" → the `ask` step) and closing it unsent (→ `onAnchorLost`,
back to `improve`) are seen the moment they happen, not at the next unrelated
re-render. (A `visibility: hidden` flip keeps the box and is not seen; no
anchor owner hides that way.)

While a tip or a step is on an anchor (its target or its cue) — or it pulses —
`useHintAnchor` calls `useReportPopupOpen(true)` (`overlay/popup-open`). So an
anchor **inside the floating action bar holds the bar unfolded** through the
counted signal the bar already obeys for its own popups; no `forceOpen` API.

## Seen state

Table `hint_seen (id pk, outcome null|acted|dismissed|completed|skipped,
seen_at)`, served as the `hints.seen` window collection (newest first, limit
250, max 500 — the set is the declared hints, dozens), **preloaded at boot** so
it is resident at first paint. Not config: config forks per worktree and resets
in browser-only hosts. `markHintSeen` upserts; `resetHints({ ids })` deletes —
the server knows no kinds, the client sends the ids it wants back
(`useHints().map((h) => h.id)` for "Show tips again"). Main is read-only for
agent sessions, so a mark from an agent browser on main is refused; the
session's answered set still keeps the tip from repeating.

`useHintCatalog()` joins every declared hint and tour with its row →
`{ kind, hint | tour, status: "seen" | "not-encountered", outcome?, seenAt? }`
(or `loading` / `error`) — the read a future "Your tips" view renders.

## UI

**One stage, animated by construction.** `HintHost` (`Core.Root`) derives a
`StageScene` from the engine — `{ spot, halos, card, welcome, toast }` — and
draws it on ONE `HintStage` (`web/components/stage.tsx`). The stage keeps one
element per piece and only moves it: the spotlight is a single box whose
`box-shadow` is the scrim, so going welcome → step 1 opens the hole out of the
center, and step → step glides it (left/top/width/height/radius); the coach
card glides beside it; a piece that leaves keeps its last content while it
fades (`useLatest`); a card that appears lands in place rather than gliding
from where it last was (`useSnapOnEnter`). A piece glides only when its
target changes (`StageBox.id`, the anchor's key, is new — the next step,
another tip); while it stays on the same target it follows it the same frame
(`useFollow`), so scrolling the page or a layout shift moves the spotlight,
halo and card with the element instead of trailing it. Every transition lives in
`hints.css`, so a new tour, step or tip is animated without declaring anything.
Reduced motion turns the durations to 0.

- `spot`: `off` · `cover` (the welcome: full scrim, takes the clicks) ·
  `hole` (dim scrim, ringed cut-out) · `ring` (`scrim: "none"`).
- `halos`: a tip's target, a step's `cue` — a pulsing ring, no scrim.
- `card`: `step` (dots, ×, footnote, alt, Back, primary) or `tip` (Got it),
  placed by the pure `placeCard` (`web/internal/placement.ts`: the preferred
  side, its opposite, then the cross axis; clamped) or centered (anchor `null`).
- `welcome` (`intro.icon` on a brand tile, title, body, Show me around / I'll
  explore on my own, `intro.note`) and `toast` (the tour's farewell, 4.8 s).
- The cut-out's padding is `step.padding` (default 6 px); its corners are the
  anchor's own radius grown by the padding — no step names a radius.

**Its own theme.** The stage wears the `hints` fixed theme
(`web/internal/hints-theme.ts`, `ThemeEngine.FixedTheme`): near-black panels,
white pill primaries, Geist, Material Rounded icons and one teal signal
(`--info`, the spotlight ring, current step dot and halo) — the same look over
every app, whatever theme the app wears. Designed in the "Getting started"
prototype (`proto-1792668692-5ijcs8`). Rects are tracked with Floating UI's
`autoUpdate`, so the cut-out, the halo and the card follow the element
together, including a layout shift that moves it without resizing it.
Exhibits: `hints/card`, `hints/spotlight`, `hints/welcome`.

## Logic, tested pure

- `web/internal/tip-queue.ts` — the queue as a value (`requestTip`,
  `removeTip`, `stepTips`, `wakeAt`); the host owns only the clock and
  eligibility.
- `web/internal/tour-machine.ts` — `transitionTour(run, event)` → `{ run, exit? }`;
  every end path reports `exit`, which the store turns into the one `ended`
  effect.
- `web/internal/catalog.ts` — `joinCatalog`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The hints engine, web half: Hints.Hint / Hints.Tour declarations, useHintAnchor (ref registration, holding a floating toolbar open while its tip shows), useHintMoment (a tip shown once at its moment, lowest order first, one at a time), startTour / autoStart, emitHintSignal, the seen state and catalog reads — and the one HintHost at Core.Root drawing the active tip (halo + card) or the tour's welcome card / spotlit step on one persistent stage — every change of scene a CSS transition of the same elements — in the hints' own fixed theme (the same look in every app), every tour end pulsing ? and toasting where the tour lives. Owns the hint_seen table — one row per hint or tour the user has met (outcome, seen_at) — served as the hints.seen live collection (boot-preloaded), with the mark-seen upsert and the reset-by-ids delete.
- Web:
  - Slots:
    - `Hints.Hint`
    - `Hints.Tour`
  - Slot contributors:
    - `Hints.Hint` ← `active-data.prototype`
    - `Hints.Hint` ← `apps.prototypes.canvas`
    - `Hints.Hint` ← `conversations.conversation-view.open-app`
    - `Hints.Hint` ← `conversations.conversation-view.push-and-exit`
    - `Hints.Tour` ← `apps.home.tour`
  - Contributes:
    - `Core.Root` → `HintHost`
    - `ThemeEngine.FixedTheme` "Onboarding hints"
    - `Shortcuts.Shortcut` "hints.tour-back (ArrowLeft)"
    - `Shortcuts.Shortcut` "hints.tour-end (Escape)"
    - `Shortcuts.Shortcut` "hints.tour-next (ArrowRight)"
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/live-state` ×3
    - `primitives/css/ui-kit` ×2
    - `primitives/dom/in-view` ×2
    - `apps-core/tabs.navigate`
    - `apps-core.useFocusedAppId`
    - `infra/endpoints.useFetchEndpoint`
    - `network/live.useLive`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/css/viewport-overlay.ViewportOverlay`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/scroll-reveal.revealElement`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/overlay/popup-open.useReportPopupOpen`
    - `primitives/shortcuts.defineShortcut`
    - `ui/icons.Icon`
    - `ui/theme-engine.ThemeEngine`
  - Exports (types):
    - `AnyTour`
    - `HintCatalogEntry`
    - `TourRunView`
  - Exports (values):
    - `emitHintSignal`
    - `Hints`
    - `setTourData`
    - `startTour`
    - `useHintAnchor`
    - `useHintAnchorPulse`
    - `useHintCatalog`
    - `useHintMoment`
    - `useHints`
    - `useHintSeen`
    - `useResetHints`
    - `useTourRun`
    - `useTours`
- Server:
  - Contributes:
    - `resource.declare` "hints.seen"
    - `resource.declare` "hints.seen:groups"
    - `resource.declare` "hints.seen:rows"
  - Uses:
    - `database.db`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `network/live.serveCollection`
  - DB schema: `plugins/hints/server/internal/tables.ts`
  - Resources:
    - `hints.seen` (keyed, window)
    - `hints.seen:groups` (push)
    - `hints.seen:rows` (keyed, point)
  - Routes:
    - `POST /api/hints/seen`
    - `POST /api/hints/reset`
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.textField`
    - `infra/endpoints.defineEndpoint`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
  - Exports (types):
    - `BoundHintAnchor`
    - `GestureAdvance`
    - `Hint`
    - `HintAnchor`
    - `HintAnchorFamily`
    - `HintContent`
    - `HintLabel`
    - `HintOutcome`
    - `HintPlacement`
    - `HintSeen`
    - `HintSignal`
    - `HintTarget`
    - `MarkHintSeenBody`
    - `ResetHintsBody`
    - `SignalAdvance`
    - `StepAdvance`
    - `Tour`
    - `TourControl`
    - `TourEndOutcome`
    - `TourIntro`
    - `TourStep`
    - `TourTrigger`
  - Exports (values):
    - `defineHint`
    - `defineHintAnchor`
    - `defineHintSignal`
    - `defineTour`
    - `HINT_OUTCOMES`
    - `HintOutcomeSchema`
    - `hintSeenEntityRef`
    - `HintSeenSchema`
    - `hintsHelpAnchor`
    - `hintsSeen`
    - `MarkHintSeenBodySchema`
    - `markHintSeenEndpoint`
    - `onSignal`
    - `ResetHintsBodySchema`
    - `resetHintsEndpoint`
    - `resolveContent`
    - `resolveLabel`
    - `resolveStepAdvance`
    - `resolveStepAnchor`
    - `targetKey`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --faint-foreground`
    - `ui/tokens/color-palette --info`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --popover`
    - `ui/tokens/color-palette --popover-border`
    - `ui/tokens/color-palette --popover-foreground`
    - `ui/tokens/font-family --font-sans`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shadow --shadow-popover`
  - Imported by:
    - `active-data/id-chip`
    - `active-data/prototype`
    - `apps/home/app-cards`
    - `apps/home/tour`
    - `apps/prototypes/canvas`
    - `conversations/conversation-view/open-app`
    - `conversations/conversation-view/push-and-exit`
    - `conversations/conversations-view/data-view`
    - `hints/help-menu`
    - `improve`
    - `shell/global-action-bar`
    - `tasks/task-draft-form`
- Sub-plugins:
  - **`help-menu`** — The ? "Getting started" menu on the global action bar — the hints engine's help anchor, ringed while a tour end pulses it — rendering the open HelpMenu.Entry slot: Replay the tour (the primary…

<!-- AUTOGENERATED:END -->
