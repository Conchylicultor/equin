# caret-trigger-safety

Contributes the repo-wide `no-adhoc-caret-trigger` ESLint rule: a file may not
scan editor text for a trigger (`lastIndexOf` / `indexOf`) from inside a Lexical
`registerUpdateListener`. Route caret menus through `useCaretQuery` +
`useCaretMenu` from
[`@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web`](../../../../../../../primitives/plugins/text-editor/plugins/caret-trigger/CLAUDE.md).

## Why

The page editor grew four independent copies of the same caret-menu loop — `/`
(slash), `[[` (page-link), `@` (date), `$$` (inline-math). Each derived its
open-state imperatively by pushing `setOpen(...)` through five early-return
branches of an update listener, and each held a `dismissedRef` boolean latch
(set on Esc / outside-press) that every one of those branches was *obliged* to
reset. Two branches never did. An empty Lexical block has no TextNode — the
selection anchor is the ParagraphNode — so the branch that cleared the latch
when the trigger text disappeared was unreachable exactly when the block was
empty: after Esc, retyping the trigger silently did nothing, permanently, for
that block. The four copies had three different reset-branch counts, the
signature of a bug patched independently four times.

The primitive replaces the latch with a derivation, so there is no reset to
forget. This rule exists so a fifth copy cannot be written.

## The rule — two shapes

### 1. Re-deriving open-state by hand

Fires on a `*.registerUpdateListener(...)` call in a file that also contains a
`*.lastIndexOf(...)` or `*.indexOf(...)` call, reporting on each listener.
Either half alone stays valid: a bare update listener is how the markdown
shortcuts, format toolbar, and the doc→row projection legitimately subscribe,
and a bare `indexOf` is just string work (the migrated plugins still use
`lastIndexOf` inside `insertLink` / `insertMention` to locate the trigger text
they are replacing). Their **conjunction** is the scan-open-state-from-editor-updates
shape, and it has no legitimate instance outside the primitive.

The rule is deliberately cheap and syntactic. A file that both subscribes to
editor updates and calls `indexOf` on an unrelated array would be a false
positive; none exists today, and the fix in that case is to move the scan or the
subscription, which is good hygiene regardless.

### 2. Taking the panel without the keyboard

Fires on an import of `CaretTriggerMenu` from the caret-trigger barrel, or of
`FloatingSurface` from `@plugins/primitives/plugins/overlay/plugins/floating-surface/web` **in an
editor file** (one importing `lexical` / `@lexical/*`, the text-editor barrel,
the caret-trigger barrel or the dom-selection barrel), in a file that never
calls `useCaretMenu`.

`CaretTriggerMenu` IS the caret-menu panel. `FloatingSurface` was evidence on
its own while its only production consumer was `CaretTriggerMenu`; it has since
become the general focus-less anchored surface (the desktop shelf's peek, the
Sonata scrubber's hover preview, the path bar, the link hover card, the
selection toolbar), none of them a caret menu. Inside an editor file it still is
the hand-rolled caret menu's panel — `url-paste`'s took `caretAnchor` from the
primitive and Lexical's `KEY_ESCAPE_COMMAND` — and keying on the panel there
catches one *however it obtained its anchor*, including an element rect.

The sources are exact specifier strings, never patterns. Until 2026-11 they
were regexes, and the `FloatingSurface` one kept matching the plugin's pre-move
path (`primitives/plugins/floating-surface`, moved under `overlay/` on
2026-09-03): the rule caught nothing, and the primitive's own exemptions were
pruned as unused. A rule's `@plugins/…` string is now located by
`plugin-meta/plugin-refs` (`plugin-refs-resolve` fails when its barrel is gone,
`./equin plugin move` rewrites it), and `rule-kind-safety/no-plugin-path-regex`
refuses the regex spelling.

Shape (1) only ever caught a menu that **re-derived** open-state. It could not
see the cheaper deviation: adopting the primitive for the half you can *see*.
`page/url-paste` did exactly that — its paste menu imported `caretAnchor` and
hand-rolled a `FloatingSurface` with three `<Row onClick>`s. It rendered in the
right place, so it looked adopted; it had no `activeIndex`, no arrow keys and no
Enter, so it was mouse-only, and it duplicated Esc through its own
`KEY_ESCAPE_COMMAND`. Nothing in shape (1) fires on it: there is no update
listener and no `indexOf`, because the open signal is a paste event.

That asymmetry is the point. Rendering is the visible half and gets copied;
arrows / Enter / Esc / the pointerdown-timed `commit` are invisible until a user
presses a key, so they get dropped — which is precisely the class of bug this
plugin exists to make unwritable. Pairing the panel with `useCaretMenu` is the
invariant that makes "it looks right" and "it works" the same condition.

**Both producers satisfy it.** A menu whose open signal is not a trigger char
(a paste, a button) is not an exception to the primitive — it is
`useForcedCaretQuery`, the second producer of the same `CaretQuery` handle, which
`useCaretMenu` consumes identically.

**A caret-anchored surface with nothing selectable now exists** — `page/editor`'s
collapsed-caret pending-marks cue. It needs no exemption: it positions itself
inside a `ViewportOverlay` rather than taking `FloatingSurface`, and
`caretAnchor` has left the menu barrel (it is plugin-private, over
`selectionRect()` from `@plugins/primitives/plugins/dom/plugins/dom-selection/web`), so the
rule keys on the menu PANEL and never sees the cue.

**The named next step.** When an *editor file* needs a genuinely non-menu
`FloatingSurface` (the consumers outside editors are already out of scope), the answer is an `interaction: "inert" |
"menu"` discriminator on `FloatingSurfaceProps`: inert makes the panel's content
`pointer-events: none`, so a mouse-only menu becomes unrepresentable rather than
merely linted, and the rule reads the declaration instead of inferring it. Not
built now — one live arm and no second consumer is speculative generality.

## Sanctioned exception

None needed today. `use-caret-trigger.ts` owns the one update listener, but its
`lastIndexOf` lives one file over in `scan-trigger.ts`; `caret-trigger-menu.tsx`
takes `FloatingSurface` through its barrel and the keyboard model as a prop, but
imports nothing that makes it an editor file. Should either change, the
primitive declares the file in its own `exempt/index.ts` (`kind: "sanctioned"`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: caret-trigger-safety lint rule: no-adhoc-caret-trigger

<!-- AUTOGENERATED:END -->
