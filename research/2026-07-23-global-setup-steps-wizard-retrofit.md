# Retrofit the Google / Apple setup wizards onto the `setup-steps` primitive

## Context

Three plugins render the same "guided numbered checklist" UI, and each owns a
private copy of it:

- `plugins/auth/plugins/google/plugins/setup-wizard` — private `Step` + `StepLink`
  at the bottom of `google-setup-pane.tsx` (lines 243–300).
- `plugins/auth/plugins/apple-signing/plugins/setup-wizard` — a near-identical
  private `Step` + `StepLink` at the bottom of `apple-setup-pane.tsx` (lines
  314–377). Same props, same colors, same icons; differs only in that it composes
  `Stack`/`Fill` where Google writes raw `flex` classes.
- `plugins/apps/plugins/deploy/plugins/ssh-setup/plugins/hetzner` — already on the
  shared primitive `plugins/primitives/plugins/setup-steps`, extracted for the SSH
  setup flow.

The primitive is a strict superset of both private copies (it adds the connecting
rail, an `active` tint distinct from `upcoming`, auto-numbering, and `StepDone`),
so the two wizards should collapse onto it. After this, the step UI has one home:
a fourth wizard is a `<Steps>` call, and a change to the step look is one edit.

Two smaller patterns are duplicated *across all three* consumers alongside the
step chrome — the muted hint caption (14 occurrences) and the copyable
command/URL row (2 occurrences). They move into the primitive in the same pass;
leaving them behind would mean the retrofit removes one duplication and preserves
two.

## Scope decisions

**Adopted, with reasons:**

1. **Add `inert` to `upcoming` steps.** Today the primitive dims an upcoming step
   with `opacity-40 pointer-events-none`, which stops the mouse but leaves the
   step's buttons in the keyboard tab order. Both wizards compensate by passing
   `disabled` down to each control — and in *every* call site that `disabled`
   condition is textually identical to the step's own `active` condition, so it is
   pure duplication of the step state. `inert` (React 19; precedent:
   `plugins/primitives/plugins/floating-action/web/internal/floating-action.tsx:81`)
   removes the subtree from pointer *and* tab reach, making "an upcoming step's
   controls cannot be reached" true by construction. That is what lets the wizards
   drop the redundant props safely rather than trading an a11y regression for
   fewer lines.
2. **Add `StepNote` and `StepCommand`** — see "Primitive changes" below.

**Explicit non-goals:**

- **No `StepError` / failed step state.** Google surfaces `connectError`
  (`text-destructive`) and Apple surfaces `certError` (`text-warning`) inline in a
  step body. Two occurrences, two different tones, two different meanings (hard
  failure vs. recoverable "enter it manually"). Not enough signal to fix a shape;
  they stay as inline `Text` in the consumers.
- **No change to how step state is derived.** Neither wizard is linear — several
  steps share one gate, and steps 2–4 (Google) / 1 and 4 (Apple) never reach
  `done` because nothing observes their completion. That is preserved exactly; the
  refactor only re-expresses the existing `(active, done)` pair as the primitive's
  `state` enum.
- The freestanding "GCP Project ID" field above Google's step list is not a step
  and stays outside `<Steps>` unchanged.

## Primitive changes

**`plugins/primitives/plugins/setup-steps/web/internal/steps.tsx`**

1. `Step` — set `inert={state === "upcoming"}` on the `<li>` and drop
   `pointer-events-none` from its className (`inert` subsumes it; `opacity-40`
   stays as the visual dim). Mirrors the `floating-action` precedent, which uses
   `inert` alone. `Stack` extends `React.HTMLAttributes<HTMLElement>` and spreads
   `...rest`, so `inert` forwards without a signature change
   (`plugins/primitives/plugins/css/plugins/spacing/web/internal/stack.tsx:54`).
   Update the doc comment: upcoming steps are dimmed *and inert* — no control
   inside one needs its own `disabled`.

2. Add `StepNote` — the muted hint line every step body uses:

   ```tsx
   /** Muted explanatory line inside a step body ("Application type: Desktop app"). */
   export function StepNote({ children }: { children: ReactNode }) {
     return (
       <Text as="p" variant="caption" className="text-muted-foreground">
         {children}
       </Text>
     );
   }
   ```

3. Add `StepCommand` — the copyable command / URL row. Lift the version already
   written in `hetzner-instructions.tsx:110-126` (which composes `Stack`/`Fill`
   correctly) rather than Google's raw-`flex` variant:

   ```tsx
   /** Copyable command or URL line: a code block plus a copy button. */
   export function StepCommand({ text, title }: { text: string; title: string }) {
     return (
       <Stack direction="row" align="start" gap="sm">
         <Fill>
           <Text as="code" variant="caption" className="rounded-md bg-muted px-sm py-xs break-all">
             {text}
           </Text>
         </Fill>
         <CopyButton text={text} title={title} />
       </Stack>
     );
   }
   ```

   New dependency on `@plugins/primitives/plugins/copy-to-clipboard/web` — a leaf,
   no cycle.

4. **`web/index.ts`** — export `StepNote` and `StepCommand`; extend the plugin
   `description` to mention them (docgen reads it).

## Consumer changes

### `plugins/auth/plugins/google/plugins/setup-wizard/web/components/google-setup-pane.tsx`

- Delete the private `Step` (243–279) and `StepLink` (281–300).
- Import `Steps, Step, StepLink, StepDone, StepNote, StepCommand` from
  `@plugins/primitives/plugins/setup-steps/web`.
- Replace `<Stack as="ol" gap="lg">` with `<Steps>`; drop every `number={n}`
  (auto-injected by position).
- Map `(active, done)` → `state`:

  | # | Title | `state` |
  |---|---|---|
  | 1 | Select or create a GCP project | `hasProject ? "done" : "active"` |
  | 2 | Enable Google Drive API | `hasProject ? "active" : "upcoming"` |
  | 3 | Set up OAuth consent screen | `hasProject ? "active" : "upcoming"` |
  | 4 | Create OAuth 2.0 credentials | `hasProject ? "active" : "upcoming"` |
  | 5 | Enter credentials | `credentialsSaved ? "done" : "active"` |
  | 6 | Connect your account | `connected ? "done" : credentialsSaved ? "active" : "upcoming"` |

- Drop `disabled` from all four `StepLink` calls (identical to the step gate).
- Step 6's Connect button: `disabled={!credentialsSaved \|\| connecting}` →
  `disabled={connecting}`; the `!credentialsSaved` half is the step gate. Keep the
  `"Connecting…"` label swap. Step 5's Save button keeps
  `disabled={!clientId && !clientSecret}` — a content guard, not a step gate.
- Steps 5 & 6 success rows → `<StepDone>Credentials configured</StepDone>` and
  `` <StepDone>Connected{status.identity?.email ? ` (${status.identity.email})` : ""}</StepDone> ``.
- Step 4's copy row (150–159, the raw `flex items-center gap-sm` + `flex-1` block)
  → `<StepCommand text={REDIRECT_URI} title="Copy redirect URI" />`.
- The two step-body hint captions → `<StepNote>` (children stay ReactNode, so
  step 4's `<span className="font-medium">Desktop app</span>` is unaffected). The
  caption under the *project-ID field* is not in a step — leave it, including its
  `mt-1` eslint-disable.
- Imports now unused: `MdCheck`, `MdOpenInNew`, `Center`, `CopyButton`.

### `plugins/auth/plugins/apple-signing/plugins/setup-wizard/web/components/apple-setup-pane.tsx`

- Delete the private `Step` (314–356) and `StepLink` (358–377); same imports and
  same `<Stack as="ol">` → `<Steps>` swap.
- Map `(active, done)` → `state`:

  | # | Title | `state` |
  |---|---|---|
  | 1 | Enrolled in the Apple Developer Program | `"active"` |
  | 2 | Create a Developer ID Application certificate | `p12Set ? "done" : "active"` |
  | 3 | Upload certificate | `certDone ? "done" : "active"` |
  | 4 | Create an App Store Connect API key | `certDone ? "active" : "upcoming"` |
  | 5 | Enter API key | `apiKeyDone ? "done" : certDone ? "active" : "upcoming"` |
  | 6 | Ready to sign | `allDone ? "done" : "upcoming"` |

- Drop `disabled` from all three `StepLink` calls. Keep the content guards
  `disabled={!p12Base64}`, `disabled={!manualIdentity}`,
  `disabled={!p8Pem && !keyId && !issuerId}`.
- Steps 3 & 5 success rows → `<StepDone>` (step 3 keeps its
  `<span className="font-mono">{identity}</span>` child).
- Hint captions in steps 2, 3 (`Selected: …`, `Stored encrypted…`), 4, 5, 6 →
  `<StepNote>`. The `certError` line stays an inline `Text … text-warning`.
- The native `<input type="file">` and its eslint-disable are untouched.
- Imports now unused: `MdCheck`, `MdOpenInNew`, `Center` (`Fill` too, unless still
  used elsewhere in the file — it is not).

### `plugins/apps/plugins/deploy/plugins/ssh-setup/plugins/hetzner/web/components/hetzner-instructions.tsx`

Fold the existing consumer onto the two new components so the pattern has exactly
one home from day one:

- Step 3's copy row (110–126) → `<StepCommand text={publicKey ? installCommand(publicKey) : "…"} title="Copy install command" />`.
  Note the current code renders `CopyButton` only when `publicKey` is set;
  `StepCommand` always renders it, copying the `"…"` placeholder in the (already
  `upcoming`, hence inert) no-key case. Acceptable — the step is unreachable then.
- Its four muted captions → `<StepNote>`. `Fill` / `CopyButton` imports drop out.

## Expected visual deltas

Intended, and the point of the retrofit — both wizards gain what the primitive
already gives the deploy flow:

- A vertical rail connecting each step's circle to the next.
- An `active` circle tinted `bg-primary/10 text-primary` instead of muted, so
  "act here" now reads differently from "not yet".
- Inter-step spacing moves from a container `gap="lg"` to each step's own bottom
  inset (so the rail has height to span). Same rhythm.

## Verification

1. `./equin build` from the worktree. This regenerates the three
   `CLAUDE.md` reference blocks + `docs/plugins-*.md` (the "Uses" lists change on
   all four plugins) and runs `./equin check`, which covers `type-check`,
   `eslint` (incl. `spacing/no-adhoc-spacing`, `no-adhoc-surface`,
   `no-adhoc-radius`), `plugin-boundaries`, and `plugins-doc-in-sync`.
2. Google wizard — `http://<worktree>.localhost:9000/settings` → Accounts →
   Google → Configure. With the project-ID field empty, steps 2–4 must be dimmed;
   confirm **Tab cannot reach their Open buttons** (this is the `inert` change).
   Type a project id → steps 2–4 light up with the primary tint and their links
   open project-scoped URLs. Check the redirect-URI copy button still copies.
3. Apple wizard — Accounts → Apple Developer → Configure. Steps 4–6 dimmed and
   tab-unreachable until a certificate with a derived identity exists; step 3
   shows the mono signing identity via `StepDone` once done.
4. Deploy regression — a server whose console URL matches `console.hetzner.com`,
   SSH section: the three steps render, the install one-liner copies.
5. Screenshot each of the three flows to confirm the rail and active tint:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/settings --out /tmp/steps
   ```

## Files touched

- `plugins/primitives/plugins/setup-steps/web/internal/steps.tsx` (edit)
- `plugins/primitives/plugins/setup-steps/web/index.ts` (edit)
- `plugins/auth/plugins/google/plugins/setup-wizard/web/components/google-setup-pane.tsx` (edit)
- `plugins/auth/plugins/apple-signing/plugins/setup-wizard/web/components/apple-setup-pane.tsx` (edit)
- `plugins/apps/plugins/deploy/plugins/ssh-setup/plugins/hetzner/web/components/hetzner-instructions.tsx` (edit)
- autogenerated: the four plugins' `CLAUDE.md`, `docs/plugins-compact.md`, `docs/plugins-details.md`
