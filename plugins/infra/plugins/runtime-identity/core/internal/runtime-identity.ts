import {
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";

// ── The runtime namespace: which app THIS PROCESS is ─────────────────────────
//
// Two identities look alike and are not. This module owns the first:
//
// - RUNTIME namespace — the namespace a backend (or an `exec` child) serves.
//   Only its SPAWNER knows it: a composition backend runs out of main's
//   checkout, so nothing about the process's own filesystem can answer it. It
//   arrives as `--namespace <ns>` on argv and is declared here, once, at the
//   entry point.
// - CHECKOUT name — which checkout a CLI is acting on, derived from its git
//   root (`checkoutWorktreeName(root)` / `checkoutNamespace(root)` in
//   `@plugins/infra/plugins/paths/core`). A CLI process has no runtime
//   namespace at all and must never ask for one.
//
// The value used to ride in `WORKTREE`, and an environment variable
// reaches every descendant forever. Main's backend was the first process to talk
// to the tmux server after a restart, so the tmux server kept main's
// environment, and from then on every agent session — and every `build`,
// `check` and `test` an agent ran — believed it was main. Nothing chose that
// value. Module state cannot be inherited, which is the whole point of putting
// the answer here instead.
//
// Design: research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md

let declared: Namespace | undefined;

/**
 * State the namespace this process runs as. Called ONCE, at the entry point,
 * before any plugin is imported.
 *
 * Idempotent for the same value, so a re-entered entry point (a test that boots
 * twice, a module evaluated down two paths) is not an error. A DIFFERENT value
 * throws: two answers to "which app am I" means half this process is reading one
 * database, one config dir and one log tree while the other half reads another,
 * and both halves look like they worked.
 */
export function declareRuntimeNamespace(ns: Namespace): void {
  if (declared !== undefined && declared !== ns) {
    throw new Error(
      `[runtime-identity] this process already declared its runtime namespace as ` +
        `"${declared}" and cannot be redeclared as "${ns}". A process serves exactly ` +
        `one namespace — its database, config dir and log tree are all named by it — ` +
        `so a second answer would leave half the process reading another app's state.`,
    );
  }
  declared = ns;
}

/**
 * The namespace this process runs as.
 *
 * Throws when nothing declared one, rather than guessing. Guessing picks a
 * database, and picking the wrong one silently is worse than refusing.
 */
export function runtimeNamespace(): Namespace {
  if (declared === undefined) {
    throw new Error(
      "[runtime-identity] this process has not declared a runtime namespace. " +
        "A backend receives it as `--namespace <ns>` from the gateway, and an exec " +
        "child from its spawner (`runExec(namespace, …)`). A CLI acting on a " +
        "checkout has no runtime namespace at all — ask `checkoutNamespace(root)` " +
        "from @plugins/infra/plugins/paths/core instead.",
    );
  }
  return declared;
}

/**
 * True when this process declared a runtime namespace — a backend, an exec
 * child, a test — and false for a CLI acting on a checkout, which has none.
 *
 * A predicate for code that runs in both kinds of process and must choose where
 * something goes before it asks `runtimeNamespace()` (which throws in a CLI):
 * a missed database deadline's log line goes to stderr in a CLI, for one
 * (`database/connection`).
 */
export function hasRuntimeNamespace(): boolean {
  return declared !== undefined;
}

/**
 * True when this process is MAIN's backend.
 *
 * A predicate, not a lookup: a process that declared no namespace — a CLI, a
 * test, a hook — is honestly NOT main, so this answers false there instead of
 * throwing. That is the exact question `paths`' shared-data move asks from a
 * CLI, and the answer the old env inheritance got wrong (every agent CLI read
 * as main). A backend that forgot to declare is still loud: its DB pool and
 * config dir ask `runtimeNamespace()`, which throws.
 *
 * Gate host-singleton work on `isHostSingleton()` (`paths`), never on this
 * alone: a compiled release runs exactly one backend per host, but under the
 * composition's name, so this is false there.
 */
export function isMain(): boolean {
  return declared !== undefined && declared === MAIN_WORKTREE_NAME;
}

/**
 * Drop the declaration. TEST ONLY.
 *
 * Two callers: the `bun test` preload, which declares the checkout it runs from,
 * and the one suite that simulates several worktrees in a single process
 * (`log-channels`' `handle-emit.test.ts`). Named for what it is so a production
 * call site reads as obviously wrong.
 */
export function resetRuntimeNamespaceForTest(): void {
  declared = undefined;
}
