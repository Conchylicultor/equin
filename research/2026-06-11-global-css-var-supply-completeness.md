# CSS theme-var supply completeness + undefined-var build check

## Context

Chips render huge under any tweakcn community theme. Root cause: `Badge` md uses the `text-caption` utility (`@utility text-caption { font-size: var(--font-size-caption) }`), and `--font-size-caption` is a runtime-injected theme var with no static fallback. `ThemeInjector` only emits the keys the **active preset** supplies (`buildVarsBlock` iterates the merged values map and skips absent keys), and tweakcn presets are *sparse* — `convertTweakcnTheme` (`plugins/ui/plugins/tweakcn/core/convert.ts`) copies only keys present in the source theme. A tweakcn theme carries colors + font families but not the type scale, so `--font-size-caption` is never emitted → `font-size` falls through to the inherited (large) value.

This is **not** a font-size-specific bug. The same `pick()`-drops-missing-keys behavior means a tweakcn import also silently drops `--success` / `--warning` / `--info` (equin-specific color tokens absent from standard shadcn themes), and partial `shape`/font values. The injector treats a **sparse preset as the complete set**, so any token a preset is silent on vanishes.

The fix is the correct definition of what a preset is: **the token-group schema default is the single source of truth; a preset is a sparse override layered on top.** Plus a build-time guard for the adjacent class (references to tokens nothing declares).

Scope here is **A**: land the sparse-override merge base + the build check now. Two follow-ups are filed and out of scope:
- **`task-1781130781653-xhuudw`** — split the `typography` group into independent font-identity vs type-scale groups (ownership; the type scale should never be perturbed by a color/font theme).
- **`task-1781128288718-p1i0tz`** — eliminate first-paint FOUC, the prerequisite for deleting the 93 static `:root`/`.dark` literals (they currently double as first-paint values).

## Part A — Sparse-override merge base + completeness assertion (the fix)

File: `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`, `GroupStyle` (the `useMemo` at lines ~62–83).

`group.descriptor.schema` is reachable at runtime and carries `{ default }` per key (confirmed via `plugins/ui/plugins/theme-engine/core/define-token-group.ts` → `TokenGroupContribution.descriptor`, `plugins/ui/plugins/theme-engine/web/slots.ts`).

1. **Seed the plain-path merge from schema defaults.** Build `schemaDefaults` once from `group.descriptor.schema` (`{ [k]: schema[k].default }`), then make it the base layer of both modes:
   ```
   const light = { ...schemaDefaults, ...active.light };   // then apply non-empty overrides
   const dark  = { ...schemaDefaults, ...active.dark };     // then apply non-empty overrides
   ```
   Built-in presets are typed as the full `TokenValues`, so this is a no-op for them; it only fills holes for sparse (tweakcn) presets — caption stays `0.75rem`, `--success` stays its canonical value, etc. The `resolve` path (shadow, lines ~65–68) is unchanged — it returns a complete `{light,dark}` already.
   - Recommended: extract the merge into a pure helper (e.g. `mergeGroupValues(schema, active, overrides)`) so it is unit-testable without rendering the component.

2. **Post-merge completeness assertion (loud backstop).** After both paths converge in the `useMemo`, assert every `Object.keys(group.descriptor.schema)` is present and non-empty in **both** `mergedLight` and `mergedDark`; otherwise `throw new Error` naming `group.id` + the missing keys. With the base fill this never fires for sparse presets (by construction); it fires only on a developer bug — an empty schema `default`, or the `resolve` path dropping a key. This is the "fail loudly" surface, correctly targeted at defects rather than normal partial presets.

Note: `transformValues` (color-adjust) only rewrites `oklch(L C H)` strings and early-returns on identity adjustment; defaulted values pass through exactly like preset-supplied ones. No interaction concern.

## Part B — `css-vars-supplied` build check (adjacent guard)

New check plugin mirroring `plugins/framework/plugins/tooling/plugins/checks/plugins/app-css-utilities-in-sync/check/index.ts` (structural template: `getRoot()`, `readFileSync`, comment-strip, inline `Check`/`CheckResult` types):

- Location: `plugins/framework/plugins/tooling/plugins/checks/plugins/css-vars-supplied/check/` with `index.ts` (default-export `Check`, id `css-vars-supplied`), `package.json`, and `CLAUDE.md` (required by `plugins-have-claudemd`). Discovered after `./equin build` regenerates `check.generated.ts` — no manual registration. **Omit `cacheSignature`** (pure function of tracked content → cacheable on tree hash).
- **DEMAND** — across `git ls-files 'plugins/**/*.css'` (comment-strip each with `.replace(/\/\*[\s\S]*?\*\//g, "")` first): match `var\(\s*(--[\w-]+)\s*(,|\))`; a match whose delimiter is `)` is fallback-less → DEMAND. Track `Map<var, file>` for the error message. (`var(--x, …)` refs have a fallback → excluded, inherently safe. This correctly excludes `pr-floating-bar`'s `var(--floating-bar-safe-area, var(--chrome-pad-x))` at app.css:350 — no allowlist needed.)
- **SUPPLY** — union of:
  - Token-group vars: glob `plugins/ui/plugins/tokens/plugins/*/shared/group.ts`, comment-strip, extract top-level schema keys with `(?:"([\w-]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{` (matches `fontSizeCaption: {` / `"categorical-1": {`, not the nested `default:`/`label:` which are followed by a string), then `camelToKebab` (`s.replace(/[A-Z]/g, m => '-' + m.toLowerCase())`) → `--<kebab>`.
  - All `--x:` declarations across every CSS file: `(--[\w-]+)\s*:`. Covers `@theme` bridges, derived `--radius-*`, and (until the FOUC follow-up deletes them) the static `:root`/`.dark` literals.
- Drop `--tw-*` from DEMAND (Tailwind internals).
- **Fail** listing each DEMAND var not in SUPPLY with its file; hint: add the token to the relevant `group.ts`, declare it in app.css, or give the reference a `var(--x, <fallback>)`.

**Scope note (state in the check's comment):** this check does **not** catch the caption bug — `--font-size-caption` *is* a token-group var, hence in SUPPLY. The caption bug is a *runtime supply* gap fixed by Part A. Part B catches the distinct *source demand* class: a fallback-less `var(--x)` referencing a token no group and no CSS declares (typos, renames, orphaned runtime-only vars). Disjoint from `app-css-utilities-in-sync` (which reconciles `@utility` class names against `control-utilities.ts`) — complementary, no overlap.

## Out of scope (follow-ups)

- **Typography split** (`task-1781130781653-xhuudw`) — font identity vs type scale as independently selectable groups.
- **FOUC / first-paint** (`task-1781128288718-p1i0tz`) — prerequisite for deleting the 93 static `:root`/`.dark` literals (all confirmed exact duplicates of token-group schema defaults). Part B's SUPPLY formulation already survives that deletion (token-group vars cover the removed literals).

## Critical files

- `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` — Part A merge base + assertion.
- `plugins/ui/plugins/theme-engine/core/define-token-group.ts` — `schema`/`default` shape Part A reads; `camelToKebab` to duplicate in the check.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/app-css-utilities-in-sync/check/index.ts` — Part B template.
- `plugins/framework/plugins/web-core/web/theme/app.css` — DEMAND/SUPPLY corpus; `pr-floating-bar` fallback (~L350); role utilities (361–366).
- `plugins/ui/plugins/tokens/plugins/*/shared/group.ts` (8 files) — supply source the check text-parses.
- `plugins/ui/plugins/tweakcn/core/convert.ts` — the sparse `pick()` that motivates Part A (reference only; not edited).

## Verification

1. `./equin build` then `./equin check css-vars-supplied` → passes on the current tree.
2. **Build check negative:** temporarily reference `var(--nonexistent-token)` (no fallback) in app.css → check fails naming the var + file; revert.
3. **Runtime fix (the bug):** with a tweakcn community theme active, screenshot the conversation header chips (`bun e2e/screenshot.mjs` / playwright helper). Confirm `Badge` chips render at caption size (~12px), not inherited-large, and that `success`/`warning`/`info` status colors resolve to their defaults rather than breaking. Compare against a tweakcn theme on `main` (broken) vs this branch (fixed).
4. **Assertion negative:** temporarily blank a schema `default` (e.g. `fontSizeCaption`) → app throws loudly on theme injection with the group id + missing key; revert.
5. **Unit tests** (vitest, alongside `plugins/framework/plugins/web-core/web/lib/utils.test.ts` precedent): the extracted `mergeGroupValues` helper — a sparse preset yields all schema keys with defaults filling holes; and a small fixture test for the check's DEMAND/SUPPLY extraction (fallback vs no-fallback, nested-brace key extraction, `--tw-*` ignore).
