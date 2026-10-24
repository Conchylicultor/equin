# no-bare-catch: flag parameterless (binding-less) catch blocks

**Date:** 2026-06-08
**Category:** global (tooling/lint + repo-wide migration)
**Status:** Implemented (2026-06-08) — rule live; 137 sites migrated (123 narrow+re-throw, 14 justified disables); all checks green.

## Context

The `no-bare-catch` lint rule
(`plugins/framework/plugins/tooling/plugins/lint/plugins/promise-safety/lint/no-bare-catch.ts`)
exists to forbid silently swallowing errors. Its `.catch()` half is thorough,
but its `try/catch` half (`CatchClause`) only fires on two **body shapes**:

- an empty catch body → `emptyCatch`
- a body where every statement is `console.error/warn` → `consoleOnlyCatch`

This leaves a hole: a catch that swallows the error with **any other** body —
`catch { continue }`, `catch { return }`, `catch { useFallback() }` — passes
clean even though it discards the error just as silently. The detection is a
shape heuristic, not a semantic one. The named real example is `discoverConfigs`
in `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts:43,50`,
where two `try { await importBarrel(...) } catch { continue }` blocks silently
skip barrels that fail to import.

The clean, false-positive-free signal is the **parameterless catch** (`catch {`
with no binding). With no binding the handler provably cannot inspect or rethrow
the original error, so it is *definitionally* swallowing it. This plan extends
the rule to flag that, and migrates the existing sites so the `eslint` check
lands green.

This is the same shape as the recently-shipped `no-adhoc-chip` guardrail
(`research/2026-06-04-global-adhoc-chip-lint-guardrail.md`): a precise rule +
in-change repo-wide migration + per-site `eslint-disable … -- <reason>` as the
only escape hatch (no central allowlist).

### Scope decisions (confirmed with user)

- **Rule scope:** parameterless `catch {` only. We do **not** also flag
  binding-but-unused catches (`catch (e) {…}` where `e` is never used and the
  body never rethrows) in this change — that needs scope analysis + a
  "never-rethrows" check and has a larger, fuzzier blast radius. Noted as a
  documented follow-up below.
- **Remediation:** **fail loudly is the strong default** — every site should
  end up re-throwing the errors it doesn't specifically expect; a justified
  `eslint-disable` (swallow-all) is a rare last resort, not a co-equal option.
  Executed by **≥16 batched Sonnet subagents** with the migration rubric below.

## Blast radius (measured)

Parameterless `catch {` blocks in the repo (excludes node_modules/dist/generated;
the `eslint` check lints everything else, incl. `bin/` and `scripts/`):

- **191** total parameterless `catch {`
- **52** already carry an `eslint-disable … no-bare-catch` → stay green
- **0** empty-body without a disable (current rule already forces those)
- **139** have a non-empty body and **no disable** → these become **new
  violations** the moment the rule lands, and must all be addressed for the
  `eslint` check to pass.

There is no per-rule `ignores` allowlist option here — that's against the
project's "no central allowlist" design (and a temp allowlist was just removed in
a recent commit). Every one of the 139 is handled in-change.

## Part A — Rule change (small)

File: `plugins/framework/plugins/tooling/plugins/lint/plugins/promise-safety/lint/no-bare-catch.ts`

Extend the existing `CatchClause` visitor (currently lines 118–127). Add a third
branch after the empty/console branches, and add a `return` to the console branch
so a catch is never double-reported:

```ts
CatchClause(node: TSESTree.CatchClause) {
  if (node.body.body.length === 0) {
    context.report({ node, messageId: "emptyCatch" });
    return;
  }
  if (node.body.body.every(isConsoleErrorOrWarnStatement)) {
    context.report({ node, messageId: "consoleOnlyCatch" });
    return; // NEW: prevent double-report with the branch below
  }
  // A binding-less catch provably cannot inspect or rethrow the original error —
  // it is definitionally swallowing it, regardless of body shape.
  if (node.param === null) {
    context.report({ node, messageId: "swallowingCatch" });
  }
},
```

Add the `swallowingCatch` message to `meta.messages`, in the style of the
existing ones:

> Parameterless `catch {` silently swallows the error — with no binding the
> handler cannot inspect or re-throw it, so unexpected failures vanish. Fail
> loudly instead: add a binding and re-throw everything you don't specifically
> expect — `catch (err) { if (!isExpected(err)) throw err; … }`. The crashes
> plugin captures uncaught exceptions automatically. Swallowing *all* errors is a
> last resort: only when any propagation would be wrong (best-effort cleanup /
> teardown), and you must say why with
> `// eslint-disable-next-line promise-safety/no-bare-catch -- <why all errors are safe to drop here>`.
> See CLAUDE.md § Promise handling.

Notes:
- `TSESTree.CatchClause.param` is `null` exactly for `catch {`; `catch (e)` has an
  `Identifier`/binding-pattern param. AST-based, so it covers `.ts` and `.tsx`.
- No barrel/codegen/registry change — the rule is already registered; this only
  edits the rule body. No `RuleTester` tests exist for these rules, so none to
  update.

## Part B — Exemplar genuine fix (do this one by hand, in the plan author's commit)

`plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts:42–53`
— the named bug. The two `catch { continue }` blocks (importBarrel failure;
reading `.default`) silently skip barrels. These should propagate unexpected
failures. Convert to a binding that re-throws (or at minimum logs *and* keeps the
skip with an explicit justification). Recommended: narrow/rethrow so a genuinely
broken barrel is loud rather than silently dropped from config-origin generation.
This serves as the worked reference the subagents mirror.

## Part C — Migrate the remaining 138 sites (batched Sonnet subagents)

### Migration rubric (handed verbatim to each agent)

**Failing loudly is the goal. The right outcome for almost every site is option
(A): the error propagates unless it is one the code specifically anticipates.**
Option (B) — swallowing all errors — is a rare last resort and must clear a high
bar. Do not reach for (B) just because it preserves current behavior; the current
silent-swallow behavior is exactly the bug this rule exists to surface.

For **each** listed parameterless `catch {` site, read the full try/catch and the
enclosing function to understand intent, then:

- **(A) Narrow + re-throw — the default. Use this unless (B) is clearly
  justified.** Add a binding, handle only the error the code anticipates, and
  re-throw everything else so unexpected failures crash loudly:
  - fs / missing file: `catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; …expected handling… }`
  - JSON parse fallback: `catch (err) { if (!(err instanceof SyntaxError)) throw err; …fallback… }`
  - otherwise narrow on the exact condition the code already anticipates, and
    `throw err` in all other cases.
  - If you can't identify a specific expected error but the original control flow
    (continue/return/fallback) is still wanted, **still add the binding and
    `throw err` for the unexpected path** — only widen what you swallow to what
    you can name.
- **(B) Justified disable — last resort, only when ANY propagation would be
  wrong.** Legitimate only for genuine best-effort paths where a thrown error
  would itself be a bug: teardown/cleanup during shutdown, fire-and-forget side
  effects whose failure is truly irrelevant. Keep `catch {` and add directly
  above it:
  `// eslint-disable-next-line promise-safety/no-bare-catch -- <why all errors are safe to drop here>`.
  The reason must justify dropping *every* error at this exact spot (e.g.
  "best-effort socket close during shutdown — nothing actionable on failure").
  Generic reasons ("pre-existing", "ignore", "best-effort") without the *why* are
  not acceptable. **If you find yourself writing more than ~1–2 (B)s in a batch,
  stop and reconsider — most sites should be (A).**

Hard constraints for agents:
- **Prefer (A). Default to making the error loud.** (B) is the exception, not the
  rule.
- Option (A) must not broaden the catch (only swallow the named expected error);
  option (B) must not change what is caught or done.
- Never "fix" by emptying the body or reducing it to `console.error` — both still
  violate the rule.
- Touch only the assigned sites; do not refactor unrelated code.
- If a site's intent is genuinely unclear, or you can't decide between (A) and
  (B), **stop and report that site** rather than guessing or defaulting to (B).
- After edits, run `bunx eslint <the batch's files> --quiet` and confirm zero
  `promise-safety/no-bare-catch` violations remain in the batch.

Each agent must return: per-site, which option (A/B) was chosen and a one-line
rationale; the count of (A) vs (B); plus any sites it flagged as unclear/risky.

### Batching (≥16 Sonnet agents, disjoint file sets, ~6–9 sites each)

The 139 split into **18 batches** — large areas are split by subdirectory so no
file appears in two batches and every agent gets a tractable load. Run all in
parallel (the workflow/Agent cap throttles concurrency automatically).

| Batch | Areas | ~count |
|---|---|---|
| 1 | `tooling/plugins/checks` (first half) | 8 |
| 2 | `tooling/plugins/checks` (second half) | 8 |
| 3 | `tooling/plugins/codegen` (excl. `config-origin-gen.ts`) + `boundaries` + `guards` + `lint` | 9 |
| 4 | `conversations/.../conversations-view/plugins/queue` + `.../grouped` | 9 |
| 5 | `conversations/.../conversation-view/plugins/jsonl-viewer` + `.../code` | 7 |
| 6 | `conversations/.../transcript-watcher` + `conversations/server/internal` + `conversation-view/web` + `pane-restore` | 7 |
| 7 | `framework/cli` (first half) | 6 |
| 8 | `framework/cli` (second half) + `framework/resource-runtime` | 7 |
| 9 | `plugin-meta` | 9 |
| 10 | `stats` | 6 |
| 11 | `infra/worktree` + `infra/attachments` | 7 |
| 12 | `infra/endpoints` + `infra/secrets` | 6 |
| 13 | `debug/profiling` + `debug/memory` | 7 |
| 14 | `debug/worktree-cleanup` + `debug/broadcasts` + `debug/logs` + `crashes` | 7 |
| 15 | `agents` + `config_v2` | 7 |
| 16 | `database` + `auth` | 6 |
| 17 | `build` + `backup` + `reorder` + `page` + `health` + `terminal` | 8 |
| 18 | `primitives/*` (tree, networking, error-boundary, live-state, persistent-draft, avatar) + `layouts` + `tasks/task-list` | 13 → split if >9 |

(Part B's `config-origin-gen.ts` is excluded — done by hand as the exemplar.) The
implementer regenerates the exact `file:line` list per batch at execution time
with the detector script (below), since line numbers may shift; the script is the
source of truth, not this table. Aim for ≥16 live agents; split any batch that
exceeds ~9 sites.

Detector (same logic used to measure the blast radius) — run before launching
agents to produce each batch's `file:line` list, and again at the end to confirm
**0** remaining:

```
# parameterless `catch {`, non-empty body, no existing no-bare-catch disable
```
(python `os.walk` + `re.compile(r'catch\s*\{')`, skipping `{ }` bodies and lines
whose previous/own line contains `no-bare-catch` — as used in this plan's
measurement.)

## Critical files

- `…/lint/plugins/promise-safety/lint/no-bare-catch.ts` — the rule (Part A)
- `…/tooling/plugins/codegen/core/config-origin-gen.ts` — exemplar fix (Part B)
- the 139 sites across the batches above (Part C)
- `eslint.config.ts` — no edit (rule already registered repo-wide as `error`)
- `…/checks/plugins/eslint/check/index.ts` — the `eslint` check that must go green

## Verification

1. `./equin build` — rebuilds; no codegen change expected (rule already
   registered). Confirm it completes.
2. `./equin check eslint` — must pass **green**, proving all 139 sites were
   fixed or justified-disabled and the rule is active.
3. Re-run the detector script → must report **0** non-disabled parameterless
   catches.
4. Negative tests (temporary): add `try { f() } catch { return }` to a `.ts` and
   confirm `eslint` flags `swallowingCatch`; confirm `try { f() } catch (e) { throw e }`
   is **not** flagged; confirm an existing justified-disable site stays green.
5. `./equin check` (full) — all checks green.

## Follow-up (separate plan, not this change)

Extend the rule to flag **binding-but-unused** catches: `catch (e) {…}` where the
binding is never referenced **and** the body contains no `throw`. Needs ESLint
scope analysis (`context.sourceCode.getScope`) to confirm the binding is unused
and a body walk to confirm nothing rethrows. Larger and fuzzier blast radius;
scoped on its own.
