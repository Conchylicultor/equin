# Teach `react-hooks/exhaustive-deps` that `useLatestRef`/`useEventCallback` returns are stable

Date: 2026-06-23 · Category: global (lint tooling + cross-plugin sweep)
Follow-up to: [`research/2026-06-23-global-react-compiler-refs-burndown.md`](./2026-06-23-global-react-compiler-refs-burndown.md) (the "Footgun to fix structurally" it flagged)

## Context

The `react-hooks/refs` burndown introduced `plugins/primitives/plugins/latest-ref`
(`useLatestRef`, `useEventCallback`) as the single sanctioned home for the
latest-value-ref idiom. `useLatestRef(value)` returns a `useRef`-backed ref whose
identity never changes; `useEventCallback(fn)` returns a permanently-stable function.

But `react-hooks/exhaustive-deps` (pinned at **error** repo-wide) does **not** know
these returns are stable. Its stable-value detector, `isStableKnownHookValue`, is
**purely syntactic** — it matches the variable initializer's callee name against a
hardcoded set (`useRef`, `useState`/`useReducer`/`useActionState` setters,
`useTransition`, `useEffectEvent`) and has **no config knob** for custom hooks
(confirmed by reading the installed `eslint-plugin-react-hooks@7.1.1` source;
`additionalHooks`/`additionalEffectHooks` only mark *effect-like* hooks, not
stable *returns*).

Consequence: every `useCallback`/`useMemo`/`useEffect` that reads a `useLatestRef`
ref must manually list that ref in its dependency array — otherwise it's a hard
"missing dependency" **error**. The listing is harmless at runtime (stable identity
⇒ no extra re-runs) but verbose, and it's a recurring "you must also update X"
coupling that **every** future migration to these hooks re-incurs. ~14 call sites
already carry it, each with a now-load-bearing `// listed only to satisfy
exhaustive-deps` comment.

**Goal:** make `useLatestRef`/`useEventCallback` returns behave *exactly* like a
bare `useRef` return — neither required nor flagged in a dep array — so the footgun
is eliminated at the source and future stable-returning primitives cost one line to
register, not a per-call-site dance.

## Approach: patch the rule with a settings-driven `stableHooks` allowlist

`exhaustive-deps` has no config for this, so we add the feature upstream forgot, in
the smallest possible patch, behind a setting **our** config owns — mirroring how
upstream already reads `settings['react-hooks'].additionalEffectHooks`. Patching is
the only approach that yields correct behavior in **all** cases (omit OR list both
accepted, correct mixed-dependency reports, safe autofix) by letting upstream's own
downstream logic handle everything once the value is marked stable. (A report-filtering
wrapper rule was considered and rejected: it would have to either over-suppress mixed
"missing dependency" reports — silencing genuine errors, violating fail-loudly — or
re-implement upstream's message + autofix.)

### Step 1 — `bun patch eslint-plugin-react-hooks` (the repo's first patch)

This is the repo's first `bun patch`. Mechanics:

```bash
bun patch eslint-plugin-react-hooks          # prints an editable copy dir
# …edit the two cjs builds (below)…
bun patch --commit <printed-dir>             # writes patches/…patch + package.json patchedDependencies
```

Edit **both** non-minified CJS builds identically — ESLint's CLI/jiti path loads
`development.js`, but `NODE_ENV=production` (CI, the type-check worker) loads
`production.js`; both keep `isStableKnownHookValue` as a named function:

- `cjs/eslint-plugin-react-hooks.development.js`
- `cjs/eslint-plugin-react-hooks.production.js`

**Edit A** — in `create(context)`, right after `const settings = context.settings || {};`,
read our allowlist once:

```js
const stableHooks = new Set(
  Array.isArray(settings['react-hooks']?.stableHooks)
    ? settings['react-hooks'].stableHooks
    : [],
);
```

**Edit B** — inside the nested `isStableKnownHookValue(resolved)` (it closes over
`stableHooks`), after `const { name } = callee;`, alongside the existing
`if (name === 'useRef' && id.type === 'Identifier') { return true; }`:

```js
if (stableHooks.has(name) && id.type === 'Identifier') {
  return true;
}
```

That's the entire behavior change: a `const x = useLatestRef(...)` / `useEventCallback(...)`
now flows through the same stable-value path as `useRef`. All downstream logic
(`stableDependencies`, `collectRecommendations`, missing/unnecessary/duplicate
classification, autofix) is upstream's and needs no further change.

> **Drift safety (fail-loudly):** `bun install` re-applies the patch on every install
> and **errors loudly** if the context no longer matches (e.g. after a version bump),
> forcing a conscious re-author rather than a silent revert. No extra check needed.
> `patches/eslint-plugin-react-hooks@7.1.1.patch` and the `package.json`
> `patchedDependencies` entry are both committed.

### Step 2 — register the allowlist in the lint config

`plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` — add a
`settings` key to the first base config object (sibling of `plugins`/`rules`, ~line 151).
Both consumers of `buildLintConfig` (the ESLint CLI via `eslint.config.ts`, and the
`type-check` worker) get it for free since both call this builder:

```ts
settings: {
  "react-hooks": {
    // Hooks whose return is referentially stable for its whole lifetime, so
    // exhaustive-deps treats them like a bare useRef (neither required nor
    // flagged in a dep array). Patched into isStableKnownHookValue via
    // patches/eslint-plugin-react-hooks@*.patch. Append a name here when a new
    // stable-returning primitive lands — that is the ONLY step a future
    // primitive needs.
    stableHooks: ["useLatestRef", "useEventCallback"],
  },
},
```

Extend the existing `react-hooks/refs`/`exhaustive-deps` comment block (lines 171-205)
with a one-line pointer to the patch + this setting, so the coupling is discoverable.

### Step 3 — sweep the now-redundant listings

With the rule fixed, drop every dep-array entry that exists *only* to satisfy
`exhaustive-deps`, plus its now-false `// …listed only to satisfy exhaustive-deps`
comment. Confirmed sites (from the burndown research + a fresh `useLatestRef` scan):

- `plugins/primitives/plugins/editable-field/web/use-editable-field.ts` — `draftRef`
- `plugins/primitives/plugins/live-state/web/use-resource.ts` — `refetchRef` (in a `useMemo`)
- `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts` — `applyRef`/`isConfirmedByRef`/`failedRef`
- `plugins/primitives/plugins/networking/web/use-reconnecting-ws.ts` — `optsRef`
- `plugins/primitives/plugins/css/plugins/color-picker/web/internal/use-color-drag.ts` — `cbRef`
- `plugins/primitives/plugins/data-view/web/internal/use-sort-presets.ts` — `setConfigRef`
- `plugins/primitives/plugins/data-view/plugins/view-core/web/internal/use-views-config.ts` — `setConfigRef`
- `plugins/primitives/plugins/sync-status/web/internal/use-report-sync.ts` — `retryRef`
- `plugins/primitives/plugins/markdown/web/internal/markdown.tsx` — `ref` (in a `useMemo`)
- `plugins/primitives/plugins/text-editor/web/components/text-editor.tsx` — `extensionsRef`/`selectionRef`/`onChangeRef`
- `plugins/layouts/plugins/miller/web/components/column.tsx` — `setWidthRef`
- `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` — multiple latest-refs
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/internal/pixi/app.tsx` — `onSceneReadyRef`/`onContextLostRef`
- `plugins/apps/plugins/sonata/plugins/controls/web/seek-hold-controller.tsx` — `seekBarRef`/`startScrubRef`/`endScrubRef`/`surfaceIdRef`/`hasSongRef`

**Critical nuance — do NOT remove cleanup-`.current` disables.** A few sites
(`pixi/app.tsx`, `seek-hold-controller.tsx`) also carry an inline
`// eslint-disable-next-line react-hooks/exhaustive-deps -- …read at cleanup/teardown`.
That disable suppresses a **different, stability-independent** warning — *"The ref
value '…current' will likely have changed by the time this effect cleanup runs"* —
which still fires after the patch (it's gathered for any `.current` read inside effect
cleanup, regardless of stability). At those sites: remove the redundant dep-array
**entries**, but **keep** the inline cleanup disable. The lint run in verification
will catch both over-removal (re-introduced missing-dep error) and any disable
directive that genuinely became unused.

The sweep is mechanical but per-site (don't blind-regex). Drive it by re-running the
lint check until clean.

## Files to modify

| File | Change |
|---|---|
| `patches/eslint-plugin-react-hooks@7.1.1.patch` (new, via `bun patch`) | Edits A+B in both cjs builds |
| `package.json` | `patchedDependencies` entry (added by `bun patch --commit`) |
| `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` | add `settings['react-hooks'].stableHooks`; extend the rule-comment block |
| `plugins/primitives/plugins/latest-ref/CLAUDE.md` | document that the two hooks are registered as stable (point at the setting); drop "must list the ref in deps" guidance |
| ~14 consumer files (Step 3) | remove redundant dep entries + stale comments; keep cleanup disables |

No new plugin, no codegen, no migration. `useEventCallback` is registered now even
though it has zero call sites today — it's stable by construction, so future adopters
inherit the fix for free.

## Verification

1. **Apply the patch end-to-end:** `./equin build` (runs `bun install`, which
   applies the patch, then the checks). A clean install confirms the patch applies.
2. **Rule actually changed (positive):** on a swept file, e.g.
   `bunx eslint plugins/primitives/plugins/editable-field/web/use-editable-field.ts`
   — expect **no** `missing dependency` after dropping `draftRef` from the array.
3. **Allowlist is what's doing it (negative control):** temporarily delete the
   `stableHooks` setting and re-run step 2 — the `missing dependency` error must
   reappear (proves the setting + patch, not luck). Restore it.
4. **No repo-wide regressions:** `./equin check type-check` (unified tsc +
   type-aware ESLint over every tsconfig target) must pass — this exercises the
   `programs`/production path and the whole sweep at once. Resolve any newly-unused
   `eslint-disable react-hooks/exhaustive-deps` directives it surfaces (but verify
   each is a missing-dep disable, not a cleanup-`.current` disable, before deleting).
5. **Full gate:** `./equin check` green.

## Optional hardening (not in scope unless wanted)

A `check/` that asserts `stableHooks` lists exactly the hooks the `latest-ref`
primitive exports would catch a future stable-returning hook being added without
registration. Deferred — the setting is one line and self-documented; revisit if a
second stable-returning primitive lands.
