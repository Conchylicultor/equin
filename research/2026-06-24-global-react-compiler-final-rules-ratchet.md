# React Compiler Compliance — Ratchet the Final 6 Rules to Error

**Date:** 2026-06-24
**Category:** global (frontend / build infrastructure)
**Status:** Plan — ready to execute (trivial)
**Follows:** [`2026-06-24-global-react-compiler-set-state-burndown.md`](./2026-06-24-global-react-compiler-set-state-burndown.md) · the coverage / `refs` / `set-state-in-effect` phases are all landed.

---

## Context

The React Compiler is enabled repo-wide (`compilationMode: "infer"`). Its Rules-of-React
eslint rules (shipped in `eslint-plugin-react-hooks`'s `recommended-latest`) are introduced
at `"warn"` by the `compilerDiagnosticRulesAsWarn()` spread in `build-lint-config.ts`, then
**ratcheted to `"error"` one rule at a time** as each rule's warning count reaches zero. The
ratchet is what locks in compiler coverage and bug-prevention: a *new* violation then fails
`./equin check` instead of silently eroding coverage or shipping a render-loop bug.

The prior phases ratcheted **11** of the 17 `recommended-latest` rules to `"error"`
(`rules-of-hooks`, `exhaustive-deps`, `purity`, `immutability`, `use-memo`, `void-use-memo`,
`static-components`, `preserve-manual-memoization`, `incompatible-library`, `refs`,
`set-state-in-effect`). **6 rules were never explicitly pinned, so they remain at `"warn"`:**

```
react-hooks/globals            react-hooks/set-state-in-render    react-hooks/config
react-hooks/error-boundaries   react-hooks/unsupported-syntax     react-hooks/gating
```

Because they are warnings, a new violation of any of these does **not** fail
`./equin check` and would accumulate silently — the exact gap this task closes. Most
notably `set-state-in-render` flags an *unconditional setState during render* (an infinite
re-render bug), and `unsupported-syntax` flags syntax that makes the compiler **silently
bail** (lost coverage) — both are things we want to hard-fail on.

**A full scan finds no backlog to burn down.** `bunx eslint "plugins/**/web/**/*.{ts,tsx}"`
(2026-06-24, 2153 web files) reports **0 errors** and **0 warnings for all six rules** (every
`react-hooks/*` rule is now at 0). The earlier burndown phases already drove the codebase to
zero. So this task is **only the ratchet + a documentation correction** — there is no
"long-tail per-rule" cleanup needed; all six can be promoted in one edit.

**Intended outcome:** all 17 React Compiler / Rules-of-React diagnostics enforced at
`"error"`; `./equin check` stays green (proving the count is truly 0); the comment that
already claims *"ALL react-hooks compiler diagnostics are now enforced at error"* becomes
true. This completes the React Compiler compliance program.

---

## The change (one file)

**`plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`** — inside
`baseConfigs[0].rules`, after the existing `"react-hooks/set-state-in-effect": "error"` pin
(currently line 228), add the six remaining pins. The `...compilerDiagnosticRulesAsWarn()`
spread (line 185) forces every rule to `"warn"`; later explicit keys win the merge, so these
pins promote them to `"error"`:

```ts
// Final 6 diagnostics RATCHETED warn→error on 2026-06-24 — their scan count was
// already 0 (no burndown needed; the coverage / refs / set-state-in-effect phases
// drove the whole tree clean). `set-state-in-render` (unconditional render-phase
// setState = re-render loop) and `unsupported-syntax` (silent compiler bail) are the
// bug/coverage-bearing ones; `globals`/`error-boundaries`/`config`/`gating` are
// rare-but-correct guards. With these, ALL recommended-latest rules are pinned to
// error. See research/2026-06-24-global-react-compiler-final-rules-ratchet.md.
"react-hooks/set-state-in-render": "error",
"react-hooks/unsupported-syntax": "error",
"react-hooks/globals": "error",
"react-hooks/error-boundaries": "error",
"react-hooks/config": "error",
"react-hooks/gating": "error",
```

### Keep the `compilerDiagnosticRulesAsWarn()` spread — do NOT delete it

After this change all 17 *currently-known* rules are explicitly pinned, but the warn-first
spread must stay: it is the **on-ramp for any rule a future `eslint-plugin-react-hooks`
version adds** — a newly-shipped rule lands at `"warn"` by default (green check, surfaces a
count to triage) rather than instantly hard-failing the build. This preserves the
warn-first-then-ratchet discipline for the next rule. Refresh the function's docstring
(lines ~89–113) and the trailing comment block (lines ~205–219) to describe this as the
*final* state: "every known rule pinned to error below; the spread now only catches
future-added rules at warn." Drop the stale clause in the docstring that still says
`preserve-manual-memoization` "stays 'warn' for now" (it is at error).

---

## Why ratchet all six at once (not per-rule)

The task anticipated *"a per-rule ratchet may be needed if some categories have a long
tail."* There is **no long tail** — the verified scan shows all six at 0. A per-rule,
promote-as-you-go sequence only matters when some rules still have violations; here a single
combined pin is correct and simplest, and `./equin check` will confirm 0 immediately.

---

## Critical files

- `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` — the 6 `"error"` pins + comment/docstring refresh (rules block ends ~line 228; spread at 185; comment block 205–219; docstring 89–113). **Only file changed.**

No other file references these rule ids (verified via `rg` across the repo, excluding
`node_modules`/`research`). The lint plugin's `CLAUDE.md` is autogen-only (no hand-written
prose about the ratchet), so nothing to update there.

---

## Verification

1. **Pre-change scan (already captured):** `bunx eslint "plugins/**/web/**/*.{ts,tsx}" -f json`
   → 0 errors; `globals` / `error-boundaries` / `set-state-in-render` / `unsupported-syntax` /
   `config` / `gating` each report **0**. (Re-run to confirm nothing drifted before editing.)
2. **Build:** `./equin build` — succeeds (runs `bun install`, regenerates, rebuilds);
   app boots at `http://<worktree>.localhost:9000`.
3. **Check green (the real proof):** `./equin check` — its `eslint` check must pass.
   Because the rules are now at `"error"`, a green run *proves* all six are genuinely at 0
   (a single violation would now fail the check). This is the success criterion.
4. **Negative test (optional, confirms enforcement actually bites):** temporarily introduce
   an unconditional `setState` in render in one throwaway component, run the `eslint` check,
   confirm it now **fails** with `react-hooks/set-state-in-render`, then revert.
5. **No runtime/behavior change** — this is lint-severity only; no component code is touched,
   so `bun run test:dom` and compiler output (G3) are unaffected. Running `test:dom` once for
   a sanity green is fine but not strictly required.

---

## Risks

1. **A masked violation surfaces between scan and ratchet** (e.g. a concurrent branch merged
   a new render-loop). Mitigated by re-running the scan in step 1 immediately before editing,
   and by step 3 — `./equin check` fails loudly rather than silently, which is the
   desired behavior. If it fails, fix the one site (or, only for a genuinely-justified case,
   add an inline `// eslint-disable-next-line react-hooks/<rule> -- <reason>` mirroring the
   existing exemption convention) and re-run.
2. **Future eslint-plugin-react-hooks upgrade adds/renames a rule.** Handled structurally by
   keeping the warn-first spread (new rules land at `"warn"`, not a build-break). No action
   needed now; documented in the refreshed comment.
3. **`config` / `gating` at error** — these validate compiler directives/feature-gating
   config and only fire on real misconfiguration (we don't use gating, so `gating` is
   permanently 0). Enforcing them at error is safe and free.

---

## Out of scope

- The non-compiler lint backlog (`@typescript-eslint/no-unnecessary-condition`, unused
  eslint-disable directives) — unrelated to this ratchet.
- The adoption doc's still-open **G2** controlled render-cost A/B on a conversation-page
  cascade — a measurement task, independent of lint enforcement.
