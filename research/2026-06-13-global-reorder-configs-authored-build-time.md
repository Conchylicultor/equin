# Surface `reorder:configs-authored` at build time (keep the manual-curation forcing function)

## Context

Making a render slot reorderable (`defineRenderSlot` without `reorder: false`) silently
incurs a second obligation: an authored override `config/<pluginId>/<slotId>.jsonc` must
exist (curated from the build-generated `<slotId>.origin.jsonc`), or the
`reorder:configs-authored` check fails. The reported symptom: this obligation is only
discovered at `./equin push`, after everything else is done and verified (hit when
adding `sonata.toolbar.start/end` — two missing overrides push complained about).

**Root cause (empirically verified, not the original hypothesis).** The check is *not*
push-only and there is *no* stale-module bug: `plugins/reorder/check/index.ts` statically
imports the freshly-regenerated `reorderable-slots.generated.ts`, and nothing imports that
manifest earlier in the build process, so during a *normal* `./equin build` the check
runs in `runChecks` (build.ts step 5) and **does** fail. Proof: a recent build's check log
(`~/.singularity/worktrees/<wt>/check.log`) lists `reorder:configs-authored ... ok`
alongside the other checks — it is in the generated registry (`check.generated.ts:53`) and
executes on every plain build. The single escape hatch is **`--skip-checks`** — the
fast-iteration flag (`build.ts:564`, documented in root `CLAUDE.md`) — which skips the
entire checks phase (`build.ts:828`), running only runtime `tsc`. No automated path passes
it (the auto-build job and the build button both run plain `./equin build`), so the
gap only opens when an agent explicitly types `./equin build --skip-checks` and then
discovers the obligation at `push` (which always re-runs `./equin check` in a fresh
subprocess).

**Decision (per user).** Do **not** auto-scaffold the override — the manual curation is
intentional, so a human/agent deliberately orders the items. Instead:
1. Make this (cheap, structural, codegen-coupled) check run **even under `--skip-checks`**,
   so it fires at build in every mode.
2. Rewrite its failure message to explain **why** the override must be authored, so the
   agent understands the task rather than mechanically copying a file.

The mechanism is generic (an opt-in flag on the `Check` interface), not a build-side
hardcode of one check id — this respects the collection-consumer separation rule (build
queries the check collection for a subset by a declared property; it never names a
contributor) and lets other codegen-coupled invariants opt in later.

## Changes

### 1. Add an opt-in `alwaysRun` flag to the `Check` interface
**File:** `plugins/framework/plugins/tooling/core/types.ts`

Add an optional field to `Check`:

```ts
export interface Check {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
  /**
   * Run even when `./equin build --skip-checks` is passed (and, as always,
   * during a normal build and `push`). For cheap, structural, codegen-coupled
   * invariants whose violation is painful to discover only at push — e.g. a
   * newly-reorderable slot that still owes an authored override. Default false:
   * the check only runs in the full check pass.
   */
  alwaysRun?: boolean;
  cacheSignature?(): string | null;
}
```

(No registry/codegen churn — it's an optional field other checks may set.)

### 2. Run always-run checks under `--skip-checks`
**File:** `plugins/framework/plugins/cli/bin/commands/build.ts` (the `if (opts.skipChecks)` branch, ~line 855)

- Add `listAllChecks` to the existing `runChecks` import from the checks barrel.
- Inside the `--skip-checks` branch, *before* the runtime-tsc loop, push a checks step that
  runs only the always-run subset, in parallel with `tsc` + `vite`:

```ts
if (opts.skipChecks) {
  // Cheap, structural checks opt into running even on the fast path, so
  // codegen-coupled obligations (e.g. an unauthored reorder override) still
  // fail at build, not only at push.
  const alwaysRunIds = (await listAllChecks())
    .filter((c) => c.alwaysRun)
    .map((c) => c.id);
  if (alwaysRunIds.length > 0) {
    parallel.push((async (): Promise<StepResult> => {
      const lines: StepResult["lines"] = [];
      const start = performance.now();
      const ok = await runChecks(alwaysRunIds, {
        logFile: join(worktreeDataDir(name), "check.log"),
        onCheckDone: (id, durationMs, wallStartMs) =>
          pushBuildSpan(`check:${id}`, "build:checks", id, durationMs, wallStartMs),
        log: (line, stream) => { lines.push({ text: line, stream }); },
      });
      return { id: "checks", label: "checks (always-run)", lines,
               durationMs: Math.round(performance.now() - start), success: ok };
    })());
  }
  // ... existing runtime-tsc targets loop unchanged ...
}
```

Notes:
- Guard on `alwaysRunIds.length > 0`: `runChecks([])` would fall through to running *all*
  checks (`runner.ts:58`), the opposite of intended.
- The full-check path (no `--skip-checks`) is unchanged — always-run checks already run
  there as part of the complete set. The result cache still applies in both modes.

### 3. Mark the check `alwaysRun` and rewrite its message to explain *why*
**File:** `plugins/reorder/check/index.ts`

- Drop the local `type Check`/`type CheckResult` re-declarations (lines 5–6); import the
  real types so the new field is type-checked:
  `import type { Check } from "@plugins/framework/plugins/tooling/core";`
- Set `alwaysRun: true` on the check object.
- Rewrite the `missing` branch message + hint to convey the rationale, e.g.:

  message:
  ```
  N reorderable slot(s) have no authored config override:
      config/.../<slot>.jsonc

  A reorderable slot's on-screen order must be a deliberate, committed layout —
  not the non-deterministic natural registration order contributions happen to
  load in. Each new reorderable slot therefore owes a hand-curated override.
  This step is intentionally manual: a human decides the order.
  ```
  hint:
  ```
  For each slot: copy its generated <slot>.origin.jsonc to <slot>.jsonc (same dir,
  drop ".origin"), keep the leading "// @hash" line, and arrange the `items` array
  for how the slot actually renders (sidebar = vertical, toolbar = horizontal bar,
  pane = stacked). See plugins/reorder/authoring-overrides.md. If this slot's order
  should NOT be user-curated, set `reorder: false` on its defineRenderSlot instead.
  ```

  Keep the existing `redundant` (grandfathered) branch and its hint as-is.

### 4. (Minor) Add the rationale to the authoring guide
**File:** `plugins/reorder/authoring-overrides.md` — prepend one sentence explaining the
*why* (committed, deliberate layout vs. natural order) so the doc the message points at
leads with intent, not just mechanics. Optional but cheap.

## Critical files
- `plugins/framework/plugins/tooling/core/types.ts` — `Check` interface (add `alwaysRun`).
- `plugins/framework/plugins/cli/bin/commands/build.ts` — `--skip-checks` branch (run always-run subset).
- `plugins/reorder/check/index.ts` — set `alwaysRun: true`, rewrite message/hint, import real `Check` type.
- `plugins/reorder/authoring-overrides.md` — lead with rationale (optional).
- Reference (no change): `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` (`runChecks`/`listAllChecks`), `reorderable-slots-gen.ts`, `config-origin-gen.ts`.

## Verification

1. `./equin build` — baseline green (all overrides already exist; grandfathered list empty → check passes).
2. **Reproduce the footgun fix:** temporarily make a slot reorderable without an override —
   e.g. delete one committed override `config/.../<slot>.jsonc`, then:
   - `./equin build --skip-checks` → **build now FAILS** on `reorder:configs-authored`
     with the new "why" message (previously it would have passed and only failed at push).
   - `./equin build` (no flag) → also fails (unchanged behavior, now with the better message).
   - Restore the override → both builds pass again.
3. Confirm `--skip-checks` still skips the *rest* of the checks (only `reorder:configs-authored`
   appears in the build's checks step; lint/type/etc. do not run).
4. Sanity: `./equin check reorder:configs-authored` runs standalone and reflects the new message.
5. `./equin check` (full) stays green.
