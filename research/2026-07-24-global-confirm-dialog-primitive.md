# Unify dialog panel chrome, add `confirmDialog`, ban the native modals

## Context

The task began as "three raw `confirm()` calls in the workflows app should use the
sanctioned `openDialog` primitive." Investigating the dialog landscape to design the
replacement surfaced a deeper structural gap, and the scope was deliberately widened to
fix it at the source.

**What exists.** There *is* a generic dialog primitive, in two layers:

- **`ui-kit` `Dialog`/`DialogContent`** — the declarative shadcn/base-ui shell (theme-scope
  forwarding via `usePortalForwardedAttrs`, `OverlayBoundary`, `SingleLineProvider`,
  `ContentScope`, portal + backdrop).
- **`imperative-dialog`'s `openDialog(render)`** — the generic "open *any* modal from a
  callback" primitive (7 live callers: wallpaper picker, SSH-key generation, an
  Ultimate-Guitar importer, several deletes). Not confirm-specific.

**Do agents render dialogs?** No — not a real pattern. Conversation UI, active-data chips,
and the workflow user-input step **all render inline** in their host surface; none opens a
modal. So there is no agent-driven dialog requirement to design around.

**The real gap.** `DialogContent` paints **zero panel chrome** — its class is only a
full-viewport positioning shell (`fixed inset-0 flex justify-center pt-[20vh]` over a
`bg-black/10` backdrop). Every caller hand-rolls the panel, and *inconsistently*:

- version-history / quick-find / command-palette / ug-import wrap their content in
  `<Surface level="overlay" className="… max-w-* rounded-xl shadow-2xl">` (each drifting on
  radius/shadow) → look like proper cards;
- the six confirm-style dialogs (delete-server, delete-deployment, replace-key,
  confirm-reset, version-history's restore, pages-trash's purge) wrap in **nothing** — a
  bare `<Stack gap="md">` → they render as **chrome-less text floating over the backdrop**:
  no card, no bg, no ring, no padding. This is a latent visual bug, not just drift.

**Outcome.** Move the panel into `DialogContent` itself (overlay chrome + a size tier +
optional padding), so every dialog — declarative or imperative — gets one consistent,
themed panel and no one hand-rolls `Surface`/width again. Then `confirmDialog` is a thin
helper that rides the unified panel for free, the 3 workflows `confirm()` calls (and the
whole class) are bannable by lint, and the six unstyled confirms are fixed as a side effect.

---

## Verified facts this rests on

- `DialogContent` today (`plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/dialog.tsx:38-68`)
  is a positioning shell only; built on `@base-ui/react/dialog` (not Radix). ui-kit exports
  only `Dialog`, `DialogTrigger`, `DialogClose`, `DialogPortal`, `DialogOverlay`,
  `DialogContent`, `DialogTitle`, `DialogDescription` — **no** `DialogHeader`/`Footer`/`AlertDialog`.
- **`SURFACE_LEVELS.overlay`** (`ui-kit/web/theme/surface.ts:36`) =
  `rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10` + custom-prop
  publishers. It lives *inside* ui-kit and is already consumed the same way by
  `popover.tsx:5,63` and `dropdown-menu.tsx:6,53` via the self-path import
  `@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/surface`. **`DialogContent`
  mirrors that precedent** — it must NOT import `Surface` (that's `primitives/css/surface`,
  which imports *from* ui-kit → importing it back closes a cycle).
- `dialog.tsx` is inside the `no-adhoc-surface` permanent exempt glob
  (`surface/lint/index.ts:32` → `ui-kit/web/components/ui/**`), and the rule only harvests
  string literals anyway (member access is invisible) — so composing `SURFACE_LEVELS.overlay`
  is doubly legal. `dropdown-menu.tsx` already uses raw `overflow-y-auto`/`flex`/`fixed` in
  this exempt tree, so the panel's raw layout classes are fine.
- `Text` supports `tone="destructive"` → `text-destructive` (`text/web/internal/text.tsx:25,64`).
- `Button` (`ui-kit/…/button.tsx:115-131`) auto-pends on a returned thenable but attaches
  only `.finally()` → a rejected `onClick` escapes as an unhandled rejection. So a
  confirm body must own the catch.
- `fetchEndpoint` does **not** toast (emits only to `endpointErrorSink`, a Reports entry);
  `useEndpointMutation` errors **are** toasted by `reports/mutation-errors`.
  `getEndpointErrorMessage` + `EndpointError` are in `@plugins/infra/plugins/endpoints/web`;
  8 `primitives/*` already import it — no cycle with `imperative-dialog`.
- **The dialog caller set is closed** (re-grepped `<DialogContent` and `openDialog(`): 5
  `DialogContent` files (4 callers + the host) and 7 `openDialog` sites — enumerated in
  Part 4. **Nothing else renders `DialogContent`; no test snapshots reference dialogs.**

---

## Part 1 — `DialogContent` becomes the panel

Rewrite `DialogContent` in `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/dialog.tsx`.
Keep the positioning shell, backdrop, `usePortalForwardedAttrs`, `OverlayBoundary`,
`SingleLineProvider`, `ContentScope`. Add a **panel `<div>`** carrying the overlay chrome +
a size tier + optional padding. Add the import (self-path, mirroring popover/dropdown-menu):
`import { SURFACE_LEVELS } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/surface"`.

```tsx
const DIALOG_SIZES = {
  sm: "w-full max-w-md",   // 28rem — confirms / alerts
  md: "w-full max-w-lg",   // 32rem — search / import / picker overlays (was max-w-lg & w-[32rem])
  lg: "w-full max-w-4xl",  // 56rem — the two-pane workspace dialog (version history)
} as const;

type DialogContentProps = DialogPrimitive.Popup.Props & {
  size?: keyof typeof DIALOG_SIZES;   // default "md"
  padded?: boolean;                    // default true (p-lg); false for flush headers/rows
};

function DialogContent({ className, children, size = "md", padded = true, ...props }: DialogContentProps) {
  const forwarded = usePortalForwardedAttrs();
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        {...forwarded}
        // eslint-disable-next-line spacing/no-adhoc-spacing -- pt-[20vh] is a viewport-relative offset the density ramp can't express
        className="fixed inset-0 z-popover flex items-start justify-center pt-[20vh] outline-none"
        {...props}
      >
        <div
          data-slot="dialog-panel"
          // Panel = SURFACE_LEVELS.overlay (same bundle Popover/DropdownMenu/Surface use)
          // + one width tier + optional padding. overflow-y-auto clips children to the
          // rounded corners (replaces callers' <Clip>) and scrolls ONLY if the panel would
          // exceed the viewport (20vh top + 75vh = 95vh). No current caller reaches the cap,
          // so their own internal ScrollAreas stay the only active scroller (no double scroll).
          // eslint-disable-next-line spacing/no-adhoc-spacing -- p-lg is the density token; ui-kit sits below the spacing primitive
          className={cn(
            SURFACE_LEVELS.overlay,
            DIALOG_SIZES[size],
            "max-h-[75vh] overflow-y-auto",
            padded && "p-lg",
            className,                    // escape hatch — version-history's h-[32rem] rides here
          )}
        >
          <OverlayBoundary kind="dialog">
            <SingleLineProvider value={false}>
              <ContentScope fill={false}>{children}</ContentScope>
            </SingleLineProvider>
          </OverlayBoundary>
        </div>
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}
```

Decisions:

- **`className` now targets the panel**, not the positioner (which is fully primitive-owned;
  no caller ever styled it). version-history's `h-[32rem]` lands here.
- **Three tiers, not two or five.** The catalog shows exactly three effective widths:
  confirm/content, 32rem (every search/import/picker), 56rem (the one two-pane browser).
  Two would force confirms to share 32rem; five would invent unused widths. Three maps 1:1
  to the real clusters: **confirm | panel | workspace**.
- **Radius → `rounded-lg`, shadow → `shadow-md`** — straight from `SURFACE_LEVELS.overlay`;
  the callers' `rounded-xl`/`shadow-2xl` were undocumented per-site drift. Token-routing means
  a future preset re-themes dialogs with menus/popovers in one edit.
- **`overflow-y-auto`, not `overflow-hidden`.** Non-visible overflow clips descendants to the
  radius (replacing `<Clip>`), and `max-h-[75vh]` scrolls a runaway panel instead of clipping
  its action row out of reach. Inert for every current caller (all cap their own body).
- **Keep `pt-[20vh]` top-alignment**; `w-full max-w-*` inside the centering flex resolves to
  `min(100%, tier)` — the standard responsive width.
- Theme scope + a11y intact: the panel is inside the same `Popup` that carries the forwarded
  attrs; the three context providers are unchanged (one box deeper).

---

## Part 2 — `openDialog` forwards panel options

`plugins/primitives/plugins/imperative-dialog/web/internal/store.ts`: add an options bag to
the store entry and `openDialog` (optional → every existing 1-arg call still compiles).

```ts
export interface DialogOptions { size?: "sm" | "md" | "lg"; padded?: boolean; className?: string }
interface DialogEntry { id: number; node: ReactNode; resolve: () => void; options?: DialogOptions }

export function openDialog(
  render: (close: () => void) => ReactNode,
  options?: DialogOptions,
): Promise<void> {
  const id = nextId++;
  return new Promise<void>((resolve) => {
    const node = render(() => closeDialog(id));
    entries = [...entries, { id, node, resolve, options }];
    emit();
  });
}
```

`web/index.ts` → also `export { openDialog, type DialogOptions } from "./internal/store";`

`web/components/imperative-dialog-host.tsx` → `<DialogContent {...d.options}>{d.node}</DialogContent>`
(the bag is exactly `DialogContent`'s new props). Return stays `Promise<void>`.

---

## Part 3 — `confirmDialog` sub-plugin

New web-only leaf `plugins/primitives/plugins/imperative-dialog/plugins/confirm/`
(`package.json`, `web/index.ts`, `web/internal/confirm-dialog.tsx`,
`web/components/confirm-dialog-body.tsx`, `CLAUDE.md`). `contributions: []` (legal — mirror
`text-editor/plugins/caret-trigger`). Barrel exports `confirmDialog` + `ConfirmDialogOptions`.

```ts
export interface ConfirmDialogOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;          // default "Cancel"
  children?: ReactNode;          // extras between description and action row (e.g. a command chip)
  onConfirm: () => void | Promise<unknown>;
}
export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean>;
```

`confirmDialog` calls `openDialog(body, { size: "sm" })` — so it inherits the unified panel +
padding; the body is a **bare `<Stack gap="md">`** (DialogTitle + DialogDescription + children
+ inline error + Cancel/Confirm row), **no Surface/width of its own**. That is the payoff of
Part 1. Fire-and-forget `void confirmDialog(...)` (never `await` inside a `Button`'s onClick —
the launching button would auto-pend for the dialog's lifetime). Returns `Promise<boolean>`:
resolves on close, `true` iff `onConfirm` completed.

**No `destructive` flag** — the confirm button is always `variant="destructive"`. Every
imperative confirm in the repo is destructive/irreversible; the affirmative *is* the danger.
A neutral "Save changes?" belongs to an inline `<Dialog>` with a primary button, not this
helper. Add the flag only if a real neutral case appears (YAGNI).

**Error policy (the design point) — the body owns the catch, because `Button` can't.** The
promise handed to the confirm `Button` **resolves in both branches** (so Button's
`.finally()`-only chain never drops a rejection). Success → mark + close. Failure → keep the
dialog **open**, render `getEndpointErrorMessage(err)` inline via `<Text tone="destructive">`,
re-enable confirm (the message *is* the retry). A non-`EndpointError` also does
`void Promise.reject(err)` to re-file the crash (an `EndpointError` already reached
`endpointErrorSink` via `fetchEndpoint`, so it is only shown, not re-filed):

```tsx
const runConfirm = useCallback(async () => {
  setError(null);
  setPending(true);
  try {
    await onConfirm();
    onConfirmed();   // sets confirmed=true in the closure
    onClose();
  } catch (err) {
    setError(getEndpointErrorMessage(err));
    setPending(false);
    if (!(err instanceof EndpointError)) void Promise.reject(err);
  }
}, [onConfirm, onConfirmed, onClose]);
```

Cancel/Confirm row: `<Fill />`, ghost Cancel (`disabled={pending}`), destructive Confirm
(`loading={pending}`). The `confirm/web → infra/endpoints/web` edge is confirmed cycle-free.

---

## Part 4 — migrate all callers off hand-rolled chrome

Two modes. **(a) `openDialog` sites** → pass `{ size, padded }`, delete their `Surface`/width
wrapper, render bare content. **(b) inline `<Dialog open>` sites** → **keep their controlled
open state** (version-history / quick-find / command-palette expose `open` as a *public prop*
their consumers drive — converting to imperative would ripple the API outward for no benefit),
just pass `size`/`padded` to their existing `<DialogContent>` and delete the inner
`Surface`/`Clip`/width wrapper.

### (a) `openDialog` sites

| Caller | Change |
|---|---|
| wallpaper-picker | `openDialog(…, { size: "md" })`; body root `<Stack gap="md" className="w-[32rem] max-w-full">` → `<Stack gap="md">`. |
| ug-import (`ug-create-option` call + `ug-import-dialog` body) | call → `{ size: "md" }`; delete `<Surface level="overlay" className="w-full max-w-lg rounded-xl shadow-2xl">`; inner `<Stack className="p-lg">` → `<Stack>` (panel pads); keep `<ScrollArea max-h-80>`; drop `Surface` import. |
| serve-target-panel → ConfirmResetDialog | **Fold into `confirmDialog`** (see below) — proves the helper end-to-end; delete `confirm-reset-dialog.tsx`. |
| generate-key-step → ReplaceKeyDialog | `{ size: "sm" }`; body already bare. |
| deployment-item-actions → DeleteDeploymentDialog | `{ size: "sm" }`; body already bare. |
| server-delete-action → DeleteServerDialog | `{ size: "sm" }`; body already bare (keep its copyable-command block). |
| deployments-section → AddDeploymentDialog | `{ size: "md" }`; **stays `openDialog`** — it's a real `<Stack as="form">`, not a confirm. |

### (b) inline `<Dialog open>` sites

| Caller | Change |
|---|---|
| version-history main | `<DialogContent size="lg" padded={false} className="h-[32rem]">`; delete `<Surface … h-[32rem] w-full max-w-4xl overflow-hidden rounded-xl shadow-2xl>`; `<Column>` becomes the direct child (its header owns `border-b px-lg py-sm`); drop `Surface` import. |
| version-history restore sub-dialog | `<DialogContent size="sm">`; keep inline (open = `pendingRestore !== null`). |
| pages-trash list | `<DialogContent size="md">`; inner `<Scroll max-h-96>` stays. |
| pages-trash purge | `<DialogContent size="sm">`; keep inline (open = `confirmEntry !== null`). |
| quick-find | `<DialogContent size="md" padded={false}>`; delete BOTH `<Clip w-full max-w-lg rounded-xl>` and `<Surface … w-full rounded-xl shadow-2xl>`; the `border-b p-sm` header + `<ScrollArea max-h-80>` become direct children; drop `Surface`+`Clip` imports. |
| command-palette | `<DialogContent size="md" padded={false}>`; delete `<Surface … w-full max-w-lg shadow-2xl>` and `<Clip rounded-xl>` (reconciles the outer `rounded-lg` vs inner `rounded-xl` mismatch to one `rounded-lg`); `border-b` header + `<ScrollArea>` + `border-t` footer become direct children; drop `Surface`+`Clip` imports. |

**The three workflows `confirm()` sites** are the original ask — but the workflows project is
**paused**, so this PR only makes them *bannable*, it does not rewrite their (wrong) copy.
Convert each raw `confirm()` to a minimal `confirmDialog` call so the lint rule lands green:

- `definition-detail.tsx` → `void confirmDialog({ title: \`Delete "${def.name}"?\`, confirmLabel: "Delete workflow", onConfirm: async () => { await fetchEndpoint(deleteDefinition, { id: definitionId }); openPane(definitionsRootPane, {}, { mode: "root" }); } })`, `handleDelete` becomes sync.
- `step-inspector.tsx` → `confirmDialog({ title: \`Delete step "${stepLabel(step, stepTypes)}"?\`, confirmLabel: "Delete step", onConfirm: async () => { await persist(deleteStep(def, step.id)); onClose(); } })`; button → `onClick={handleDelete}`.
- `execution-detail.tsx` → `confirmDialog({ title: "Cancel this run?", confirmLabel: "Cancel run", cancelLabel: "Keep running", onConfirm: () => fetchEndpoint(deleteExecution, { id: execution.id }) })`.

(Keeping the copy terse-but-accurate is fine; the honest-copy rewrite is a follow-up for when
workflows is unpaused — see Follow-ups.)

**Recommendation on the other pure-confirms:** fold **only** `ConfirmResetDialog` now (one
real `confirmDialog` consumer, and its inline-error path is a UX upgrade). Leave
`DeleteServerDialog` / `DeleteDeploymentDialog` / `ReplaceKeyDialog` as `openDialog + {size:"sm"}`
for this PR — recently-landed, their `.then(close).catch(EndpointError)` is deliberate, and
`DeleteServerDialog` carries a copyable-command block. Fold them in a fast-follow.
`AddDeploymentDialog` never folds (it's a form).

---

## Part 5 — lint rule `imperative-dialog/no-native-dialog`

New `plugins/primitives/plugins/imperative-dialog/lint/{index.ts, no-native-dialog.ts,
no-native-dialog.test.ts}`. Auto-discovered into `lint.generated.ts` by `./equin build`
(imperative-dialog had no `lint/` before). Barrel `name: "imperative-dialog"`. Keep `lint/`
free of any `@plugins/*` import (jiti can't resolve the alias).

Bans, via `ESLintUtils.RuleCreator`:
- bare `confirm(x)`/`alert(x)`/`prompt(x)` — **scope-resolved to the ambient global** using
  the `resolveVariable`-style walk from `plugins/primitives/plugins/pane/lint/no-hint-fabrication.ts`.
  **Mandatory, not optional:** `prompt` is an endemic local/param/import name in this repo
  (llm-prompt step, prompt-editor, claude-cli); a name-only matcher would fire hundreds of
  times and, at `error`, break the build. Match only when the identifier resolves to *no*
  binding in any enclosing scope.
- member forms `window.confirm(x)` / `globalThis.*` / `self.*` — object a bare identifier in
  `{window, globalThis, self}`, non-computed. `document.foo.confirm()` and `dialogs.confirm()`
  are deliberately not matched.

One `messages` entry naming the replacement (`confirmDialog` / `openDialog`). **No `ignores`,
no `enforceEverywhere`** — the rule is scope-precise, and the audit confirms zero other
`confirm/alert/prompt` calls repo-wide after Part 4 (the only textual hit is `alert(1)` inside
a *string literal* XSS fixture under `__tests__/`, where contributed rules are off anyway).
Test: `RuleTester` with the plain `@typescript-eslint/parser` (syntax + scope only, **no type
services**); valid cases must cover the whole false-positive class (imported `prompt`, `prompt`
param, `const prompt`, local `function confirm`, `obj.confirm()`), invalid cases cover bare +
all three member forms.

---

## Part 6 — docs, verification, risks

**Hand-written CLAUDE.md:**
- `css/plugins/ui-kit/CLAUDE.md` — "Dialog owns the panel": `DialogContent` paints the
  `SURFACE_LEVELS.overlay` box + `size` (`sm`/`md`/`lg`) + `padded`; callers pass content only
  and must **not** wrap their own `Surface`/`Clip`.
- `imperative-dialog/CLAUDE.md` — flip "the `render` owns its own panel chrome" → "the host's
  `DialogContent` provides the panel; `render` owns only content + a `DialogTitle`"; document
  `openDialog(render, options?)`; cross-link the new `confirm` sub-plugin.
- new `imperative-dialog/plugins/confirm/CLAUDE.md` — fire-and-forget idiom + why, the error
  policy (stay-open → inline → retry) and why reporting keys on `EndpointError` while stay-open
  does not, why no `destructive` flag.

**Autogen (never hand-edit)** — `./equin build` regenerates `web.generated.ts` (new
`confirm` plugin), `lint.generated.ts` (new `imperative-dialog` lint entry), every touched
CLAUDE.md fence (migrated callers' `Uses` lists drop `Surface`/`Clip`), `docs/plugins-{details,compact}.md`.

**Verification:**
```bash
./equin build
bun test plugins/primitives/plugins/imperative-dialog/lint/no-native-dialog.test.ts
rg 'Surface|Clip' <each migrated dialog file>   # must return nothing dialog-related — proves double-wrap risk closed
./equin check
```
Checks that care: `plugins-registry-in-sync`, `plugins-doc-in-sync`, `plugins-have-claudemd`,
`type-check` (tsc + type-aware ESLint — where the new rule runs repo-wide and `plugin-boundaries`
would surface a bad import/cycle), `eslint`, `surface/no-adhoc-surface` (dialog.tsx exempt;
confirm no migrated caller still open-codes overlay), `radius/no-adhoc-radius`,
`spacing/no-adhoc-spacing` (panel `p-lg`/`pt-[20vh]` carry per-line disables).

Then drive it (`plugins/screenshot` / e2e-harness `screenshot.ts`) and eyeball, per tier:
command palette (md), quick-find (md), version history (lg), a delete-server confirm (sm),
wallpaper picker (md), UG import (md). Prove: **single** ring/shadow (no doubling), flush
`border-b` rows clipping to the rounded corners, 20vh top-align, correct widths; and for
`confirmDialog` specifically — confirm button **pends** while the mutation runs, a **failure
keeps the dialog open** with the message inline (repro: stop the backend), Escape/backdrop
dismisses without acting.

**CRITICAL risk — double-wrap.** Now that `DialogContent` paints a panel, any caller that
still wraps its own `Surface` inside it gets doubled ring/shadow/bg + a radius clash. Part 4
is therefore exhaustive by construction: the closed set is the 5 `DialogContent` files + 7
`openDialog` sites (re-grepped); **no `DataView`/other renderer touches `DialogContent`, and
no dialog test snapshots exist**. The `rg 'Surface|Clip'` gate above is the proof. Theme-scope
forwarding survives (panel is inside the same `Popup`). `padded` defaults `true`, so a flush
caller that forgets `padded={false}` gets stray `p-lg` — mitigated by the three flush callers
passing it explicitly and the docs. `overflow-y-auto` double-scroll is neutralized because no
caller's content reaches `max-h-[75vh]`.

---

## Follow-ups (not in scope)

- Fold `DeleteServerDialog` / `DeleteDeploymentDialog` / `ReplaceKeyDialog` into `confirmDialog`
  (the copyable `sed` row rides in via `children`), leaving one confirm shape repo-wide.
- Honest-copy rewrite of the three workflows confirms (what each destroys vs. keeps) — deferred
  because the workflows project is paused. Notably `deleteExecution` is a naming footgun (the
  handler *cancels* and keeps the row); worth an `add_task` to rename it `cancelExecution`.
- Optional future lint: ban a bare `<Surface>`/`<Clip>` directly under `<DialogContent>` to
  guard the double-wrap regression structurally.
