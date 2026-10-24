# Clicking a row must not pin its action buttons

## Context

Normally a row's trailing buttons appear when the pointer is over the row and vanish when it
leaves.

The bug: clicking a row leaves its buttons on screen after the pointer leaves. They stay until you
click a different row, whose buttons then stay instead — so one row on the surface is always
showing its actions. The strongest case is an agent transcript: expand a tool call, move the
pointer away, and the timestamp / copy / raw-json buttons are still there.

The cause is one line. `RowActions` reveals its cluster on `group-focus-within/row-actions`, and
`rowActionsAnchor` — the element that group lives on — is **the whole row**, not a dedicated
trigger. So focus landing on *anything* inside the row pins the cluster, and an ordinary click puts
focus somewhere inside the row on every surface:

| Row family | What takes focus on a click |
|---|---|
| Tool / thinking / attachment transcript rows | `CollapsibleCard`'s full-bleed toggle `<button>` (`collapsible-card.tsx:129`) |
| Assistant text | `ContentScope`'s `tabIndex={-1}` div — Chromium focuses the nearest focusable ancestor when you click non-focusable prose (`select-scope.tsx:40`) |
| User text | inline file-path link `<button>`s emitted by the `file-links` walker |
| Tree rows | the chevron `<button>` (`tree-row-chrome.tsx:198`) |
| Table rows / list rows / gallery cards | any focusable cell content, and `Row`'s own primary `<button>` on the split path |

### What the census changed about the brief

Two corrections worth stating, because they shrink the work:

- **Every reported surface already routes through one component.** After `f7110e8c3`, `Row`,
  `TreeRowChrome`, `DataTable`, `DataCard` and the jsonl `EventRow` all render their cluster via
  `RowActions`, and `row-actions/no-raw-actions-slot` forbids a second implementation. The
  "row-based list views behaved this way before the convergence" note is historically true but no
  longer a separate site — `Row` dropped `useHoverReveal` in that commit. **One class string is the
  whole fix.**
- **Sonata's library cards do not have this bug.** `song-card.tsx:117` uses `hoverRevealTarget`,
  the self-scoped default. The brief listed it as "expected to behave the same"; it does not.

Repo-wide there are exactly two other literal `group-focus-within` reveals:
`hoverRevealTargetWithGroupFocus` (correct — both consumers anchor on a genuine dedicated trigger)
and `SidebarMenuAction`'s `showOnHover` branch (dead: zero JSX consumers).

### Intended outcome

Clicking never pins a hover-revealed affordance — not on a row, and not on the five non-row
surfaces that reach the same behaviour through the `useHoverReveal` hook — while a keyboard user
can still reach every one of them.

## Design

### The reveal rule: hover, or keyboard focus inside the cluster

```
plugins/primitives/plugins/row-actions/web/internal/row-actions.tsx:43-46
```

```diff
 const revealClasses =
   "opacity-0 pointer-events-none select-none transition-opacity " +
   "group-hover/row-actions:opacity-100 group-hover/row-actions:pointer-events-auto " +
-  "group-focus-within/row-actions:opacity-100 group-focus-within/row-actions:pointer-events-auto";
+  "has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto";
```

Two changes in one, and both are load-bearing:

- **`has-[…]` instead of `group-…`** moves the focus question from the row to the cluster. `:has()`
  matches descendants only, and the reveal classes ride the outermost node the primitive renders
  (the `Pin`, or the `Stack`/`Surface` when `pin={null}`), which contains exactly the action
  buttons. Nothing in the row body can satisfy it. This is the same containment `hover-reveal`
  reaches with self-scoped `focus-within`, expressed for a node whose focusable content is a child
  rather than itself.
- **`:focus-visible` instead of `:focus`** keeps the reveal keyboard-only. Chromium does not mark a
  mouse-clicked button as focus-visible, so clicking an action no longer pins its own cluster
  either. Tabbing to it does, since a Tab keypress always sets focus-visible regardless of prior
  mouse use. This is already the app's spelling for "keyboard can reach this" —
  `tree-row-chrome.tsx:102`, the three `tree-disclosure` variants, and
  `workflows-sidebar.tsx:115` all use bare `focus-visible:` for exactly this.

Hover is untouched. `PopupOpenScope` is untouched — an open menu still holds its cluster visible
through the typed signal, which is what `row-actions-overflow.ts` asserts.

Rewrite the doc comment above `revealClasses` (it currently promises "while focus is anywhere
inside the row") and the `rowActionsAnchor` comment, which no longer describes a focus scope.

### Keyboard reachability, concretely

Tab order through a list is: row primary button → the cluster's buttons (they follow in DOM order;
`pointer-events-none` and `opacity-0` do not remove an element from the tab sequence). Focusing a
row shows nothing; one more Tab lands inside the cluster and reveals it in the same tick, so there
is never a frame where a focused button is invisible. This is the trade `hover-reveal` documents in
`group-reveal.ts:10-15`, taken deliberately.

### The same bug written in JavaScript: `useHoverReveal`

`RowActions` is one of two reveal mechanisms. The other is the `useHoverReveal` hook, which tracks
hover in React state and hands the caller four handlers to spread on the container:

```ts
// use-hover-reveal.ts:38
onFocus: () => setRevealed(true),
```

React's `onFocus` bubbles up from children, so focusing anything inside the container turns the
reveal on. That is `group-focus-within` with different syntax — the convergence doc says so outright
(line 104: JS `onFocus` spread on the row "is exactly `group-focus-within/row-actions`"). Same
symptom: in a data-view filter row, click the field dropdown or type in the value box, move the
pointer away, and the row's remove button stays.

Apply the same rule, in the same words the CSS fix uses:

```diff
-      onFocus: () => setRevealed(true),
+      // Keyboard focus only, for the reason the row-actions cluster keys on
+      // `:focus-visible`: this handler fires for ANY descendant, so a plain
+      // click inside the container would otherwise pin the affordance open
+      // once the pointer left.
+      onFocus: (e: FocusEvent) => {
+        if ((e.target as Element).matches(":focus-visible")) setRevealed(true);
+      },
```

`onBlur` is unchanged — it already clears only when focus leaves the container entirely.

Five consumers change behaviour, all of them containers that wrap focusable content:

| Surface | File |
|---|---|
| Filter rule row (field / operator / value + remove) | `data-view/web/components/filter/filter-rule-row.tsx:50` |
| Nested filter-group row | `data-view/web/components/filter/filter-group-editor.tsx:86` |
| Sort rule row | `data-view/web/components/sort/sort-rule-row.tsx:46` |
| Saved-view switcher chip strip | `data-view/plugins/view-core/web/components/editable-view-switcher.tsx:69` |
| Floating-desktop pager pill | `apps-core/surface/floating/web/components/workspace-pager.tsx:134` |

The sixth consumer, `sonata/progress/loop/…/loop-region.tsx:115`, is unaffected: the only focusable
thing under its anchor is the target button itself, so keyboard reach is identical either way.

Note a deliberate difference from the CSS side. Text inputs are always focus-visible in Chromium,
even when clicked — so clicking a filter rule's value box still reveals its remove button. That is
correct: the user is editing that row. The reveal ends when focus leaves.

### Also, small

`SidebarMenuAction`'s `showOnHover` branch (`ui-kit/…/ui/sidebar.tsx:594`) is the same pattern —
group-focus-within, and with no `pointer-events` coupling at all, so at rest it would be an
invisible live click-target. It has **zero JSX consumers**; the conversations sidebar it once served
moved to `RowActions`. Delete the `showOnHover` prop and its class branch rather than carrying a
fourth reveal implementation that `no-raw-actions-slot` structurally cannot see. Flagging it here
rather than assuming — it is vendored shadcn, and keeping it is a defensible call.

## Files

| Path | Change |
|---|---|
| `plugins/primitives/plugins/row-actions/web/internal/row-actions.tsx` | the `revealClasses` swap above + rewritten comments |
| `plugins/primitives/plugins/row-actions/CLAUDE.md` | record the rule: hover, or keyboard focus **inside the cluster**; why the row's own focus must not count; why `has-[:focus-visible]` and not `focus-within` |
| `plugins/primitives/plugins/data-view/plugins/gallery/web/__tests__/data-card-actions.test.tsx` | line 37 asserts `group-focus-within/row-actions:opacity-100` — the only test pinning the old string. Assert the two `has-[:focus-visible]:` classes instead, and that `group-focus-within` is **absent** |
| `plugins/primitives/plugins/row-actions/e2e/click-does-not-pin.ts` | **new** (below) |
| `plugins/primitives/plugins/hover-reveal/web/internal/use-hover-reveal.ts` | the `onFocus` guard above |
| `plugins/primitives/plugins/hover-reveal/CLAUDE.md` | record that the hook's focus reveal is keyboard-only, and why (it fires for any descendant) |
| `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/sidebar.tsx` | drop the dead `showOnHover` branch (see above) |

`Row`, `TreeRowChrome`, `DataTable`, `DataCard`, `EventRow`,
`Breadcrumb` are unchanged — they own placement, and the reveal they inherit is the one line above.

### The e2e

`plugins/primitives/plugins/row-actions/e2e/click-does-not-pin.ts`, on the shared harness
(`arg`, `pathUrl`, `withBrowser`, `report` from
`@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e` — the same imports
`row-actions-overflow.ts` uses). Parameterized `--url` + `--row` (accessible name or selector) so
one script covers several surfaces; defaults to the Pages sidebar, whose selectors
`row-actions-overflow.ts` already proved stable.

Read the cluster's opacity with that script's proven helper — walk up from the action button to the
first ancestor whose computed opacity is not `1` (`row-actions-overflow.ts:114-119`), since the fade
lives on the cluster, not the button.

Per surface:

1. **Hover reveals** — pointer over the row, assert opacity `1`. Without this the rest is vacuous:
   a cluster that never shows would pass every "is hidden" assertion.
2. **Click does not pin** — click the row body, move the pointer far off the row, assert opacity
   `0`. This is the bug.
3. **Keyboard still reaches** — pointer parked away from the row, press `Tab` until
   `document.activeElement` is inside the cluster (bounded loop), assert opacity `1`.
4. **Mouse-focus does not pin** — mouse-click the `⋯` trigger to open its menu, mouse-click it
   again to close (focus returns to the trigger, last interaction is a mouse), move the pointer
   away, assert opacity `0`. This is the half `focus-within` would fail and `:focus-visible` passes.

Surfaces to run it against:

- **Pages sidebar** — tree and list views, `PageTree.RowActions`.
- **An agent transcript** — the reported case, and the only one exercising `CollapsibleCard`'s
  full-bleed toggle and `ContentScope`. Pass `--url http://<worktree>.localhost:9000/agents/c/<id>`
  and target a tool-call row.

**Gallery is not browser-covered**, honestly: no `defineItemActions` consumer ships a gallery view
today. The jsdom test above is what stands behind it, and it proves composition, not behaviour.

## Verification

1. `./equin build`; confirm `status: ok` in
   `~/.singularity/worktrees/att-1786065015-wyap/build-status.json` (never infer from a
   `build-*.log`).
2. **Confirm Tailwind actually emitted the new variant.** `has-[…]` appears nowhere in the repo
   today, so this is the one genuinely novel piece: grep the built CSS for
   `has-\[\:focus-visible\]\:opacity-100`. A silently-unemitted class would leave the cluster
   permanently unreachable by keyboard, which no assertion above would catch.
3. **Prove the e2e red first**, per surface: revert `revealClasses` to `group-focus-within/…` and
   confirm assertion 2 fails; set it to plain `focus-within:` and confirm assertion 4 fails.
   A test never observed failing is not evidence.
4. `bun plugins/primitives/plugins/row-actions/e2e/click-does-not-pin.ts` for each `--url`/`--row`
   pair (Pages sidebar tree, Pages sidebar list, a transcript tool-call row).
5. `bun plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts` — unchanged, must
   stay green. It asserts the popup-open hold, which this change must not disturb.
6. `./equin test plugins/primitives/plugins/row-actions plugins/primitives/plugins/data-view/plugins/gallery plugins/primitives/plugins/css/plugins/row`
   (both buckets).
7. `./equin check` — `eslint`, `type-check`, `tailwind-scan-covers-classes`,
   `plugins-doc-in-sync`.
8. **Manual pass on the five `useHoverReveal` surfaces**, since they have no e2e: open a DataView's
   filter editor, click a rule's field dropdown, move the pointer away — the rule's remove button
   must be gone. Repeat for a sort rule, a saved-view chip, and a floating-desktop pill. Then tab to
   each remove button and confirm it appears.
9. **Manual keyboard pass**, which is the thing being traded and deserves eyes: tab through the
   conversations sidebar, the Pages tree, and the Events sources table. Every row's actions must
   become visible the moment focus enters them, and the focus ring must be legible against the
   cluster's scrim.
10. **Manual pointer pass** on the reported surface: open a conversation, click a tool call to
   expand, move the pointer away — the timestamp / copy / raw-json buttons must be gone. Repeat for
   assistant prose (click the text) and a user message with an inline file link.

## Deliberately not doing

**Sonata's library card.** `song-card.tsx:113` hand-rolls a delete button on `hoverRevealTarget`
instead of routing through `RowActions`. It does **not** have this bug — `hoverRevealTarget` is the
self-scoped variant — but it is a second cluster on a card, which is what the convergence existed to
end. The cause is structural: the gallery's `renderCard` option short-circuits before the `DataCard`
that carries `actions={itemActions}` (`gallery-view.tsx:195`), so a custom card silently drops the
actions its consumer already declared. Filed as its own task
(`task-1786067063808-23d2e9`) because the fix is an API-shape decision about `renderCard`, not a
class string.
