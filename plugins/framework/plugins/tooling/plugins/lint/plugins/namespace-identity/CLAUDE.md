# namespace-identity

A repo-wide ESLint rule against **answering "which namespace?" with something
that is not one.**

- **`no-laundered-checkout-namespace`** — `asNamespace(checkoutWorktreeName(…))`
  and `asNamespace(basename(…))` are banned everywhere. A checkout's directory
  name is one **input** to a namespace, not a namespace.

(Its sibling `no-ambient-worktree-env` banned the retired worktree environment
variable by name. It is gone because that variable can no longer be spelled:
the app's variables are declared by key in `infra/launcher/env-names`, which has no
`WORKTREE` key, so `readEnv("WORKTREE")` is a type error and
`launcher:env-names` rejects a full variable name written in TypeScript code.
See [below](#the-retired-worktree-variable).)

## Why `no-laundered-checkout-namespace`

`checkoutWorktreeName(root)` returns a plain `string` deliberately, and its own
docblock says why: the two are equal for every agent worktree today and stop
being equal the moment a composition is served from a non-main checkout. A
`--composition sonata` build publishes `sonata.<checkout>` and never the
checkout's own name at all.

`asNamespace` is the validating cast at a **serialization boundary** — a DB
column, a URL host, a spec-directory entry name. Handing it a name someone
derived from a filesystem path is not a boundary read; it is a guess, stated as
fact, that the `Namespace` brand exists to stop. The cast then names a deploy
that may not exist while a real one sits beside it, and every URL, database,
config directory and log file that follows resolves against whatever else answers
that name.

That is not hypothetical. `e2e-harness/e2e/target.ts` carried

```ts
asNamespace(process.env.<the worktree variable> ?? checkoutWorktreeName(REPO_ROOT))
```

so every argument-less e2e run from a worktree drove **main's** deploy, reverted
the user's live config documents there, and printed `ALL CHECKS PASSED`.

That one expression carried two errors, and they are closed separately: the
`e2e-harness:target-not-env-derived` check bans the environment read, and this
rule bans the cast that let a checkout name stand in for a namespace at all.
Either half alone would have been enough to reintroduce the bug. See
[`research/2026-09-08-global-e2e-target-checkout-deploy-identity.md`](../../../../../../../../research/2026-09-08-global-e2e-target-checkout-deploy-identity.md).

## What the message points at

Not just the ban — the two right answers:

- **Mint it.** `namespaceFor(compositionId, ref)`, or `checkoutNamespace(root)`
  when the composition is the main app.
- **Read it.** When what you want is the deploy this checkout actually
  published, `resolveCheckoutDeploy(root)` from
  `@plugins/infra/plugins/paths/core` reads it off the registry on disk, where
  it was recorded at mint time, instead of re-deriving it from a name.

For a directory listed under `~/.equin/worktrees`, the entry name *is* a
namespace — but the read there is `isNamespace`, whose non-throwing answer lets
one stray directory be skipped rather than take a whole scan down with it.

## The retired worktree variable

It answered "which namespace is this RUNTIME the server for", which is a real
question — but an environment variable answers it for every descendant forever.
Main's backend was the first process to talk to the tmux server after a restart,
so the tmux server kept main's environment, and from then on every agent session
started life believing it was main. Every `build`, `check` and `test` those
sessions ran filed its records under the main namespace. Nothing chose that value; it
was simply present.

The replacements are two, and which one you want depends on what you are:

- a RUNTIME (a gateway-spawned backend, an `exec` child) — `runtimeNamespace()`
  from `@plugins/infra/plugins/runtime-identity/core`, declared once at the entry
  point from the `--namespace` its spawner passed;
- a CLI acting on a checkout — `checkoutNamespace(root)` /
  `checkoutWorktreeName(root)` from `@plugins/infra/plugins/paths/core`.

Spawning a child that needs one? Pass `--namespace <ns>` on its argv. Never an
env key: that is the inheritance the retirement ended. See
[`research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md`](../../../../../../../../research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md).

## Scope, and the fallback shapes

The rule steps through `??` / `||`, ternaries and type assertions before looking
at the producer call, because the live instance spelled the laundering one
operator down from the cast; a rule matching only the direct nesting would have
seen nothing at the one site that mattered. It cannot follow a binding
(`const name = checkoutWorktreeName(root); asNamespace(name)`) — that limit is
recorded as a `valid` fixture in the suite rather than left unstated. The direct
nesting is the shape every live instance took, and the runtime rungs stand behind
it: `resolveCheckoutDeploy` refuses when no deploy answers, and the e2e identity
assert refuses when the origin is serving a build this checkout did not publish.

`enforceEverywhere`, so it survives in test and e2e files where contributed
rules are otherwise off (see the [lint](../../CLAUDE.md) plugin). It catches
a bug rather than an architecture deviation, its remedy lives in `core` barrels
that `e2e` may legally import, and — decisively — the defect that motivated it was
written in an `e2e/` file. A rule switched off in the file its own bug lived in
enforces nothing.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: One lint rule against answering 'which namespace?' with something that is not one: no-laundered-checkout-namespace bans casting a checkout directory name to a Namespace.

<!-- AUTOGENERATED:END -->
