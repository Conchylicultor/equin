# Toast: a mount-scoped ledger, and an enqueue sonner can't drop

## Context

The "Dismiss all (n)" affordance shows a count that outlives the toasts — an empty
corner with a `Dismiss all (3)` button under it. This is the **second** time this bug
has been fixed.

- `fce83e8bf` shipped the affordance counting `useSonner()`.
- `4c608c015` replaced that with the plugin's own ledger, because `useSonner()` is a
  second copy of the toast list pruned only through a droppable rAF hop.

The second fix is deployed (main is on `f7110e8c3`) and the bug survives it. Reproduced
against the live app: **465 notifications posted, 462 ever reached the DOM, 3 never
rendered**; the button claimed 96 with 91 live.

Both attempts failed the same way: each maintained a **parallel copy** of "what is on
screen", with its own update path, and neither had a way back once that copy drifted.
This plan removes the copy rather than replacing it — the ledger becomes the set of
mounted toast bodies, which React maintains for us.

### Defect A — the ledger's invariant is false

`web/internal/live-toasts.ts` records a toast at **enqueue** time (`showToast` calls
`trackToast`) and retires it only from sonner's `onAutoClose` / `onDismiss`, plus a
bespoke `untrackToast` in the action-button handler (the one exit sonner reports through
neither). So the ledger assumes *handed to sonner ⇒ rendered ⇒ an exit callback fires*.
A toast that never renders is counted forever, with no repair path.

Verified: all five `deleteToast` call sites in sonner (timer, `toast.delete` effect,
close button, swipe, cancel) do pair with a callback, so DOM removal always untracks.
**The leak is only never-rendered toasts.**

### Defect B — sonner silently discards some enqueues

`Observer.publish` (`sonner/dist/index.mjs:132`) is `subscribers.forEach(s => s(data))` —
synchronous, no buffer, no replay on later subscribe. `addToast` (`:135`) publishes and
then appends to `ToastState.toasts`, an array nothing renders from. The only rendering
subscriber is the `<Toaster>`'s, registered at `:956-993` in:

```js
React.useEffect(() => ToastState.subscribe(...), [toasts])
```

keyed on its own toast list — so it tears down and re-registers on **every** add and
removal. React runs all passive destroys for a commit before any passive creates, so
each such commit has a synchronous stretch with zero subscribers (since `4c608c015`
dropped `useSonner()`, the Toaster is the *only* subscriber, so the list is genuinely
empty). A producer calling `showToast` from a `useEffect` lands in it — which is exactly
what `BellButton` does (`plugins/shell/plugins/notifications/web/components/bell-button.tsx:131-142`),
the app's dominant toast producer.

## Design

**A: the ledger is the mount set.** We already render our own component inside every
toast, so the registration point is free. `showToast` mints the id, passes it to sonner
explicitly, and the toast body registers on mount / retires on unmount. Every exit —
timer, close button, swipe, action button, programmatic dismiss, the host unmounting —
converges on that one unmount, so none of them needs enumerating. An enqueue sonner
drops never mounts, so it is never counted. There is no state left that isn't derived
from something on screen.

**B: never publish from inside React's commit phase.** A microtask checkpoint only
occurs at stack-empty, and React's passive flush (destroy pass + create pass) is one
synchronous call — so a `queueMicrotask`ed publish always lands after the Toaster has
re-subscribed. `showToast` returns `void` and no caller reads a return value or depends
on synchronous delivery (verified: zero `= showToast(` repo-wide; all 10 call sites are
effects, event handlers, or imperative module functions — no render-phase or
`useLayoutEffect` producers).

Rejected: **re-assert on drop.** `ToastState.toasts` is never pruned, so `create()`'s
merge-by-id matches ids from toasts that died minutes ago and republishes them — a
mistimed re-assert *resurrects* a dismissed toast. It also needs an unknowable deadline
and a second bookkeeping map, reintroducing what this change deletes.

### Decision: exiting toasts stay counted

The mount set includes a toast for its ~200ms exit animation (`TIME_BEFORE_UNMOUNT`,
`sonner/dist/index.mjs:425`), where today's callbacks untrack the instant fading starts.
Accepted deliberately: the count becomes exactly "toasts currently painted", the button
fades out with the stack, and it costs nothing. It also fixes a case the current code
gets wrong — `Observer.dismiss()` hops through rAF, so in a throttled tab today's
`clearTrackedToasts()` zeroes the count while toasts are still on screen.

Consequence: the count is now `[data-sonner-toast]` (all of them), not
`[data-sonner-toast]:not([data-removed="true"])`. **The e2e must move with it** or it
gains a 200ms flake window.

## Implementation

### `web/internal/show-toast.tsx` — rewrite

Delete `ToastIdHolder` and the `holder` plumbing, the `untrackToast` in the action
handler, and `onAutoClose` / `onDismiss`. Rename `ClickToDismiss` → `ToastBody` (it now
owns both on-screen concerns) and give it the id as a plain prop.

```tsx
// Page-unique ids we mint ourselves. We need the id *before* the enqueue (the body
// carries it), and it must never repeat: create() merges by id against
// ToastState.toasts, an array sonner never prunes, so a reused id resurrects a
// long-dead toast. A string is disjoint from sonner's numeric counter by
// construction; the session prefix survives an HMR reload restarting `seq` under a
// live sonner module. Must never be falsy — `data?.id || counter++` (dist:374)
// would silently hand the toast a sonner id and desync the ledger.
const SESSION = Math.random().toString(36).slice(2, 8);
let seq = 0;

function ToastBody({ id, children }: { id: string; children: React.ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null);

  // Its own effect: the click wiring below bails when the sonner <li> isn't found,
  // and tracking must not inherit that early return. Idempotent under StrictMode's
  // create→destroy→create because the ledger is a Set keyed by id.
  useEffect(() => {
    trackToast(id);
    return () => untrackToast(id);
  }, [id]);

  useEffect(() => { /* unchanged click-to-dismiss, using `id` instead of holder.id */ }, [id]);

  return <span ref={anchorRef} style={{ display: "contents" }}>{children}</span>;
}

export function showToast({ title, description, variant, action }: ToastArgs): void {
  const id = `shell-toast-${SESSION}-${++seq}`;
  const rawMessage = title || description;              // see "drive-by" below
  const rawDescription = title ? description : undefined;
  const fn = variant && variant !== "default" ? sonnerToast[variant] : sonnerToast;

  // Built eagerly so the element snapshots the caller's strings and any JSX error
  // surfaces on the caller's stack, not inside the microtask.
  const body = (
    <ToastBody id={id}><ContentScope fill={false}>{rawMessage}</ContentScope></ToastBody>
  );

  // Deferred one microtask, never published inline — see the Defect B note in this
  // plan. Does NOT cover a producer calling us from render or a layout effect.
  queueMicrotask(() => fn(body, { id, description: …, action: … }));
}
```

Register in the **title slot only**. Sonner renders `toast.title` unconditionally in the
`[data-title]` div (`dist:794-797`) but the description div only when present; two
registrations against one Set entry would let the first unmount untrack a toast the
other half still shows — an undercount, the worse direction.

Drive-by fix, same function: `title ?? description` doesn't catch `title: ""`, so
`showToast({ title: "", description: "x" })` renders an empty toast and drops the
description. `||` fixes it.

### `web/internal/live-toasts.ts` — trim

Delete `clearTrackedToasts` and the `ToastId` export (ids are now always ours ⇒ `string`).
Rewrite the module doc: everything after *"So the affordance counts what we handed to
sonner instead"* is now false. State the new invariant — the ledger is the mount set;
exits need no enumeration; a dropped enqueue is never counted — and its scope: exiting
toasts count for ~200ms, and toasts queued past `visibleToasts` count (sonner mounts all
of them, `visibleToasts` only drives opacity — and sweeping those is the button's whole
justification). Keep the `scoped-store/no-module-mutable-store` disable on `let count`.

Keep the store a **Set**, never a counter — StrictMode double-invoke makes every mount
`track → untrack → track`.

### `web/components/toaster-host.tsx` — delete the lifetime hook

Remove the `useEffect` that clears the ledger on both edges, plus the now-unused
`useEffect` / `clearTrackedToasts` imports. React unmounting the toast subtrees does it,
and does it correctly even if `<Sonner>` unmounts without the host.

### `web/components/dismiss-all-button.tsx` — drop the sweep

`onClick={() => sonnerToast.dismiss()}`. Update the doc paragraph that still explains the
count in terms of `useSonner()`.

### Net

Deleted: one type, one exported function, two sonner callbacks, one bespoke untrack, one
lifecycle effect, one mutable-holder indirection, and the comments explaining an
enumeration that no longer exists.

## Tests

**`web/internal/live-toasts.test.ts`** (bun:test, co-located — pure logic):
double `trackToast` is one entry with one notification; `untrackToast` of an unknown id
notifies nobody; the StrictMode shape `track → untrack → track` settles at 1 (this is the
test that stops someone "simplifying" the Set into a counter); `getSnapshot` returns a
stable primitive.

**`web/__tests__/toast-ledger.test.tsx`** (vitest/jsdom — 71 such suites exist already).
Mount sonner's `<Toaster/>` directly, not `ToasterHost`, to avoid dragging in theme-engine
and ui-kit. Needs a `flushToasts()` helper draining microtasks then timers under `act`
(sonner does `flushSync` inside a `setTimeout`, `dist:969`), with fake timers configured
to fake `requestAnimationFrame` (the dismiss path needs it, `dist:185`/`:960`).

1. Count equals mounted toasts — assert the *equality*, not the number.
2. **Defect A regression:** `<Probe/>` with no `<Toaster/>`; 5 toasts → count `0`. Fails on current code.
3. **Defect B regression:** `<><Producer/><Toaster/></>` where `Producer` fires from a `useEffect`; passive creates run in tree order, so an inline publish has no subscriber. → exactly 1 rendered. Fails on current code, and mirrors the real `AppsLayout`-before-`ToasterHost` ordering.
4. Deferral, directly: `toast.getHistory().length` unchanged synchronously, `+1` after one microtask.
5. Action button — the deleted bespoke untrack: click `[data-action]`, caller's `onClick` ran, count drains.
6. Auto-close with the exit window pinned: at 4000ms both `<li>`s are `data-removed` **and** the count is still 2; at +200ms it is 0. Documents the accepted semantics so a future edit argues with a test.
7. Host unmount drains the count.
8. All five variants mount the body (`toastFunction` and `create` are different code paths — cheap insurance against a sonner bump).
9. Description-only and title+description each count exactly 1 (guards against registering in the description slot too).

**`e2e/dismiss-all-verify.ts`** — add an `ALL` locator (`[data-sonner-toast]`, exiting
included) for the count invariant, keeping `LIVE` for the geometry assertion. Upgrade
`assertVisibleIffPlural` to parse `/Dismiss all \((\d+)\)/` and assert `n === ALL.count()`
— the number is now assertable, which is the actual bug. Add a burst no-drop check: a
`MutationObserver` counting distinct `[data-sonner-toast]` insertions across a tight
~20-toast burst, asserting `observed === seeded` (the only place Defect B is observable
end to end).

## Verification

1. `./equin build` (regenerates the plugin doc block; `plugins-doc-in-sync` will fail otherwise).
2. `./equin test plugins/shell/plugins/toast` — both runners.
3. `bun plugins/shell/plugins/toast/e2e/dismiss-all-verify.ts` against the worktree deploy.
4. Confirm the two regression tests fail when reverted onto current `show-toast.tsx`.
5. Re-run the drop probe that found this (burst notifications, compare posted vs ever-rendered via MutationObserver, then assert the button's number equals the stack) against the worktree deploy — the original repro was 3 dropped in 465.

## Risks

- **The exit-window skew flaking the e2e.** Not optional; land the e2e change in the same commit.
- **A future sonner bump.** The fix leans on three source facts: `toast.title` renders unconditionally in `[data-title]`; both `toastFunction` and `create` honour an explicit non-empty string id; `<Toast>` unmounts on every exit. Tests 5 and 8 are the tripwires — note sonner 2.0.7 in the code comment.
- **Id uniqueness is load-bearing**, not cosmetic: a repeat hits `create()`'s merge against the never-pruned `ToastState.toasts` and resurrects a dead toast. Session prefix + monotonic seq; keep the comment.
- **Two `<ToasterHost/>` at once** would break the un-refcounted Set (first unmount untracks a toast the second host still shows). Not a supported configuration — `Core.Root` gives one contribution per plugin — and today's code is wrong there too. Noted in a comment, not fixed.

## Follow-ups (out of scope)

- `Observer.dismiss()` with no id iterates `ToastState.toasts`, which never shrinks — one "Dismiss all" click fans out one publish per toast *ever fired* this session. Works (batched into a frame), but the button's cost grows without bound. Upstream issue.
- `showToast` from render or a layout effect would still hit the zero-subscriber window. No such caller exists; a lint rule is the cheap guard if one ever appears.
