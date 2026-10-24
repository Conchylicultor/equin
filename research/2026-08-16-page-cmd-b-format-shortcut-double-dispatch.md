# Cmd+B applies bold twice, so it applies it not at all

## Context

Cmd+B never applies the bold mark in the page block editor — not on a collapsed
caret (type a character after it: stored unmarked), and not on a text selection
(the selected run is stored unmarked). Cmd+E in the same run, same block, same
key-press mechanism, DOES store the `code` mark. So the keystroke reaches the
editor and the shortcut path works for at least one mark.

The defect was invisible until now because nothing in the editor displayed a
collapsed caret's pending marks. The new pending-marks cue found it, and two
assertions in `plugins/page/plugins/editor/e2e/pending-marks-cue-verify.ts`
(phase 4, lines 421-424) are currently red because of it — deliberately left red
rather than weakened.

The intended outcome: all five shortcuts in the editor's own shortcut table
(`bold`, `italic`, `underline`, `code`, `strikethrough`) apply their mark, on a
collapsed caret and on a range, and the table is actually the single owner of
those keys rather than claiming to be.

## Root cause (verified in the installed source)

Not a bold-specific bug and not a browser quirk. **Cmd+B is dispatched twice, so
it toggles bold on and then off.**

`lexical@0.44.0` (pinned in `bun.lock`; every `package.json` asks for `^0.44.0`),
`Lexical.dev.mjs`:

| line | what happens |
| --- | --- |
| 2861-2868 | `onKeyDown` does one thing: `dispatchCommand(editor, KEY_DOWN_COMMAND, event)` |
| 2430 | `$handleKeyDown` is registered as a `KEY_DOWN_COMMAND` listener at **`COMMAND_PRIORITY_EDITOR` (0)** |
| 2938-2946 | inside `$handleKeyDown`'s `if/else` chain: `else if (isBold(event)) { event.preventDefault(); dispatchCommand(editor, FORMAT_TEXT_COMMAND, 'bold'); }` — and the same for `underline` and `italic` |
| 2974-2976 | **outside** that chain, unconditionally: `if (isModifier(event)) editor.dispatchCommand(KEY_MODIFIER_COMMAND, event)` |

So one ⌘B keydown produces, in order:

1. `FORMAT_TEXT_COMMAND('bold')` — from Lexical's built-in branch;
2. `KEY_MODIFIER_COMMAND` — which our `FormatShortcutsPlugin`
   (`plugins/page/plugins/editor/web/components/format-shortcuts-plugin.tsx:37-71`)
   turns into a **second** `FORMAT_TEXT_COMMAND('bold')`.

`RichTextPlugin` is mounted (`web/components/block-text-editor.tsx:361`), so
`registerRichText` handles both. Two toggles of the same mark = net no change —
identically for a collapsed caret and for a range.

`code` (⌘E) and `strikethrough` (⌘⇧X) have **no** branch in `$handleKeyDown`, so
they fire once and work. `italic` (⌘I) and `underline` (⌘U) do have one, so they
are broken exactly as bold is — untested in the report, predicted broken here,
and the new e2e below settles it.

The report's framing ("marks with no native browser equivalent work") names the
right partition for the wrong reason: the discriminator is not the browser, it is
whether `$handleKeyDown` has an `else if` for that key.

Two independent facts corroborate this and rule out the alternatives:

- **The toolbar's Bold button works.** `web/components/mark-button.tsx:53`
  dispatches the very same `FORMAT_TEXT_COMMAND(mark)` on click — once — and
  bold applies. So `FORMAT_TEXT_COMMAND('bold')` is not broken; only the path
  that fires it twice is. (These two are the only `FORMAT_TEXT_COMMAND` dispatch
  sites in the repo, and nothing registers a listener for it.)
- **Nothing else touches the keystroke.** `internal/caret-authority.ts:302`
  returns early on `ctrlKey || metaKey`, so its capture-phase handler passes ⌘B
  through untouched (pinned by `web/__tests__/caret-authority.test.tsx:385-406`),
  and no `defineShortcut` anywhere binds `mod+b`.

### The false assumption in the plugin

`format-shortcuts-plugin.tsx:17-23` says:

> Because this handler returns `true` for the marks it owns, the framework
> default never double-fires.

That cannot hold. The framework's format dispatch happens **strictly before**
`KEY_MODIFIER_COMMAND` is even created, inside the same listener call. A return
value from a command dispatched later cannot unwind a command dispatched
earlier. The comment describes a mechanism that does not exist.

## The fix

Move the handler from `KEY_MODIFIER_COMMAND` to **`KEY_DOWN_COMMAND` at
`COMMAND_PRIORITY_NORMAL`** — one file, no new abstraction.

`triggerCommandListeners` walks priorities `4 → 0` and stops at the first
listener returning `true` (`Lexical.dev.mjs:8912-8929`). `$handleKeyDown` sits at
priority `0`. So a `KEY_DOWN_COMMAND` listener at `NORMAL` (2) that returns
`true` preempts the **entire** built-in chain for that keystroke — the
`FORMAT_TEXT_COMMAND` branch and the trailing `KEY_MODIFIER_COMMAND` dispatch
alike. The plugin's ownership claim stops being aspirational and becomes
structurally true: there is exactly one dispatch per shortcut, ours.

File: `plugins/page/plugins/editor/web/components/format-shortcuts-plugin.tsx`

- swap the command constant and keep everything else — the same `SHORTCUTS`
  table, the same `mod && !altKey` predicate, the same `preventDefault()` +
  `dispatchCommand(FORMAT_TEXT_COMMAND, …)` + `return true`;
- keep the ⌘K branch in the same handler. It still runs synchronously inside the
  DOM keydown dispatch, so its `stopPropagation()` / `stopImmediatePropagation()`
  still beat the window-level command palette exactly as today;
- add a cheap first line — `if (!event.metaKey && !event.ctrlKey) return false;`
  — because this listener now sees every keystroke, not only modified ones;
- **rewrite the Ownership paragraph.** It is the load-bearing comment in the
  file and it is currently wrong. Replace it with the mechanism above, citing
  `Lexical.dev.mjs:2430` (the `COMMAND_PRIORITY_EDITOR` registration),
  `2938-2946` (the built-in b/i/u branches) and `2974-2976` (the unconditional
  `KEY_MODIFIER_COMMAND` dispatch) — the same citation style
  `internal/mark-depth.ts` already uses for pinned library invariants.

Nothing else in the repo listens to either command (`rg KEY_MODIFIER_COMMAND
KEY_DOWN_COMMAND plugins/` returns only this file), so no other consumer loses a
dispatch.

### Why not the smaller fix

Deleting `bold`/`italic`/`underline` from `SHORTCUTS` also stops the
double-toggle. It is rejected: it splits the shortcut map between "framework
defaults" and "ours", which is precisely what the file's header says it exists to
avoid; it silently hands ⌘I/⌘U to Lexical's `CONTROL_OR_META` mask, which is not
our `mod && !altKey` rule; and it leaves the plugin claiming an ownership it does
not have. The one-word change above costs the same and makes the claim true.

## The gap that let this ship: the shortcut table has no test

`inline-format-verify.ts` covers marks applied by **typing markdown**.
`mark-boundary-verify.ts` and `pending-marks-cue-verify.ts` press ⌘E only, and
only as a fixture for something else. **No script has ever asserted that the
shortcut table applies its marks** — which is why four of five shortcuts could be
inert (⌘U is the *only* way to apply underline; it has no markdown syntax) with
nothing going red.

New script: `plugins/page/plugins/editor/e2e/format-shortcuts-verify.ts`,
asserting the **persisted runs** (`GET /api/pages/:pageId/blocks` → `data.text`),
per `inline-format-verify.ts`'s rule that a DOM-only read passes on a mark that
never left the browser.

Phases, each over a fresh block, for **all five marks** (a table driving the
phases, so a sixth mark added to `SHORTCUTS` is one row here):

1. **Collapsed caret.** Type `aa`, press the shortcut, type `b` → runs are
   `[{aa, []}, {b, [mark]}]`. The report's first repro, generalized.
2. **Range.** Type `hello`, `Shift+ArrowLeft` ×5, press the shortcut → runs are
   `[{hello, [mark]}]`. The report's second repro.
3. **Toggle-off.** From phase 2's state, press the shortcut again → runs are
   `[{hello, []}]`. This is the assertion that names the defect directly: a
   double dispatch is indistinguishable from a double press, so a shortcut that
   silently fires twice fails here even if someone later "fixes" phase 2 by
   accident.
4. **⌘K still opens the link popover** (DOM read) — the other branch of the same
   handler, which the command move must not regress.

Helper reuse: `openBlankPage` / `blockText` / `caretState` from
`e2e/support/blank-page.ts`. The persisted-runs reader (`fetchRows`, `runsOf`,
`settledRuns`) exists file-locally in `mark-boundary-verify.ts:145-175`; lift
those three into a new `e2e/support/runs.ts` and import it from both — a third
hand-rolled copy is where the duplication stops being cheap, and migrating the
one existing copy is mechanical.

## Documentation to correct

- `pending-marks-cue-verify.ts:404-412` — delete the "KNOWN PRODUCT BUG"
  paragraph once phase 4 is green. Leave the rest of the phase untouched.
- `plugins/page/plugins/editor/CLAUDE.md`, *Depth is STORED, never derived from
  `selection.format`*, mechanism 1 (line ~651): it names ⌘E as the collapsed-caret
  toggle that aliases depth 1. With the whole table live, the mechanism is the
  table, not one key — widen the sentence.
- Same file, in the mark-boundary section: record the trap in one short
  paragraph, so the `KEY_MODIFIER_COMMAND` design is not reintroduced —
  *a shortcut Lexical already handles cannot be owned from
  `KEY_MODIFIER_COMMAND`, which `$handleKeyDown` dispatches after its own
  format branch has already run; own it from `KEY_DOWN_COMMAND` above
  `COMMAND_PRIORITY_EDITOR`.*

## Verification

1. `./equin build` (background — see the workflow rule).
2. `bun plugins/page/plugins/editor/e2e/format-shortcuts-verify.ts` — new, all
   green. Before the code fix it must be red for bold/italic/underline and green
   for code/strikethrough; run it once against the pre-fix build to prove it is
   not vacuous.
3. `bun plugins/page/plugins/editor/e2e/pending-marks-cue-verify.ts` — phase 4's
   two ⌘B assertions flip red → green; every other phase unchanged.
4. `bun plugins/page/plugins/editor/e2e/mark-boundary-verify.ts` — the regression
   net for the `KEY_DOWN_COMMAND` move: it drives ⌘E, arrow steps and Backspace
   through the same editor and asserts persisted rows.
5. `bun plugins/page/plugins/editor/e2e/inline-format-verify.ts` — typing and
   undo unaffected.
6. `./equin check`.
7. By hand at `http://<worktree>.localhost:9000`: ⌘B/⌘I/⌘U/⌘E/⌘⇧X on a selection
   and on a caret; ⌘K inside a block opens the link popover; ⌘K outside a block
   still opens the command palette.

## Outcome (2026-08-16)

Done as planned. The diagnosis held, including the part the report had not
tested.

**The pre-fix baseline was run first**, against a build with the one-file fix
stashed, precisely so the new script could not pass vacuously —
`format-shortcuts-verify.ts` came back **6 red of 27**, and exactly the predicted
six: P1 (collapsed caret) and P2 (range) for **bold, italic AND underline**,
with `code` and `strikethrough` green throughout and ⌘K green. So italic and
underline were broken too — untested in the report, predicted here from the
`$handleKeyDown` branch list, confirmed by measurement. P3 (toggle-off) passed
for the broken marks in that run, unmarked before and unmarked after: the vacuous
pass the header's phase-2/3 pairing note describes, observed rather than
hypothesised.

After the fix, on the same build pipeline:

| script | result |
| --- | --- |
| `format-shortcuts-verify.ts` (new) | 27/27 |
| `pending-marks-cue-verify.ts` | 20/20 — phase 4's two ⌘B assertions red → green |
| `inline-format-verify.ts` | 39/39 |
| `mark-boundary-verify.ts` | phases 1-10 pass; **phase 11 fails, pre-existing** |

**`mark-boundary-verify.ts` phase 11 is broken independently of this work and is
NOT fixed here.** Its fixture pastes `` `code`[[<pageId>]] `` and requires the
token to become an inline page-link chip; the token stays literal text, so the
phase's four crossing claims fail on their own precondition (`decoratorCount` 0).
A minimal probe — paste that string, count `[data-lexical-decorator]` — reproduces
it **identically on `main`**, which carries none of these changes. The markdown
paste path itself is fine there (the backticks do become a `{code}` run); it is
the `[[…]]` protected-span → chip step that no longer fires. Worth its own task:
it silently breaks pasting page links, and phase 11 is currently a standing red
that will mask the next real regression in caret-crossing.
