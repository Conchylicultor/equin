# Commit identity for clone and fork users

## Context

A fresh install never sets `user.name` / `user.email`, and it should not have
to: asking at install time is an extra manual step for an identity that, in a
clone, never leaves the machine. Today git fills the gap itself from the login
and hostname (`epot@etiennes-macbook-pro1.home`, verified 2026-09-29), which
has two failure modes:

- a hostname with no domain part → `fatal: unable to auto-detect email address`,
  and `./equin push` dies mid-flight at its `git commit`;
- otherwise every commit carries a hostname-derived junk email, which becomes
  public the day that checkout publishes (a fork, or a clone later granted write
  access).

Rule: **identity is decided when a commit is about to be made, not at install,
and the answer depends on whether the commit can leave the machine.** Push
already measures exactly that (`resolvePublishTarget`,
`plugins/infra/plugins/git/plugins/remotes`).

## Where commits are made

Only two commands create or rewrite commits (agents never run raw `git commit`,
enforced by guards):

1. `./equin push` — `git commit -m` (run.ts ~471), then the rebase
   `--exec` trailer amend (~527), which rewrites the committer on every replayed
   commit. `resolvePublishTarget` is already called at ~364, before the mutex
   and before the commit.
2. `./equin upstream merge` / `--continue` — `git merge` (writes a merge
   commit) and `git commit --no-edit`
   (`plugins/framework/plugins/cli/plugins/upstream/cli/merge.ts`).

Nothing in the app UI commits; "the app pushes" means an agent running
`./equin push`. So the check goes into those two commands and nowhere else
— not `install.sh`, not the doctor, not `mise install`.

## Design

One function in the remotes plugin, next to the publish-target measurement it
depends on:

```ts
// plugins/infra/plugins/git/plugins/remotes/core/internal/commit-identity.ts
ensureCommitIdentity(root: string, target: PublishTarget): Promise<CommitIdentity>
```

It reads the identity **as git will resolve it for this checkout** (all config
scopes, plus `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL` / `EMAIL` in the env),
and distinguishes three states: *explicit* (the user set it somewhere),
*ours* (the auto identity this function wrote earlier, marked by
`singularity.autoIdentity=true` in `--local` config), and *missing*.

| state \ target | `local` (cannot publish) | `publish` |
|---|---|---|
| explicit | use it | use it |
| missing | write an auto identity to `--local` config, print one line | **refuse** (below) |
| ours | use it | remove our `--local` keys, then re-resolve: explicit ⇒ use it, missing ⇒ **refuse** |

**Auto identity (local only).** Written with the existing `gitConfigSet`
(`--local` = the clone's config, shared by every worktree, untracked):
- `user.name`: what git already derives from the account (the name part of
  `git var GIT_AUTHOR_IDENT`), falling back to `$USER` when that is empty — so no
  per-platform code (`id -F`, getent).
- `user.email`: `<user>@singularity.invalid` — `.invalid` is reserved (RFC 2606),
  so it can never be mistaken for, or route to, a real address, and no hostname
  ends up in history.
- `singularity.autoIdentity=true`, so a later publisher run knows it may remove
  them.

Push prints once, when it writes them:
`Commits in this clone are signed "Etienne <epot@singularity.invalid>" — they stay on this machine. Set your own with git config --global user.email … whenever you like.`

**Refusal (publish only).** Exit 1 before the push mutex, the commit or any
network step, so nothing is half-done:

```
This checkout publishes to <url>, so its commits will be public — and git has no
name or email to sign them with. Set them once:

  git config --global user.name  "Your Name"
  git config --global user.email "you@example.com"

then re-run ./equin push. (Agent: ask the user — never invent an identity.)
```

The author's own checkout and every normal fork already have a global identity,
so in practice this fires only for someone who publishes from a machine that has
never committed anything.

**Why the "ours" row matters.** A clone that later becomes a fork (or gets
write access) would otherwise publish with the placeholder forever. Removing our
own keys at the first publishing push makes the refusal (or the user's real
global identity) take over. Commits already made under the placeholder stay as
they are — rewriting published-to-be history is not worth it; the refusal
message mentions it.

## Changes

- `plugins/infra/plugins/git/plugins/remotes/core/internal/commit-identity.ts` —
  `ensureCommitIdentity` + a pure `decideIdentity(state, target)` (the table
  above) so it is unit-testable without git. Export from the core barrel.
  `CommitIdentity` is a discriminated result (`explicit` / `auto-written` /
  `auto-kept` / `refuse` with the message) — no nullable absorbed failure.
- `plugins/framework/plugins/cli/plugins/push/cli/run.ts` — call it right after
  `resolvePublishTarget` (~364); on `refuse`, print and `process.exit(1)`.
- `plugins/framework/plugins/cli/plugins/upstream/cli/merge.ts` — call it at the
  top of `startMerge` and of `--continue` (it needs `resolvePublishTarget` too,
  which is cached in `.git/config`, so no extra network round trip).
- `plugins/infra/plugins/git/plugins/remotes/CLAUDE.md` — a short "Commit
  identity" section: when it is decided, the table, why `.invalid`.
- Nothing in `install.sh`, `mise.toml` or the doctor.

## Verification

- `remotes/core/internal/commit-identity.test.ts`: `decideIdentity` over all six
  cells; plus a real-git test in a temp repo with `GIT_CONFIG_GLOBAL=/dev/null`
  and `GIT_CONFIG_NOSYSTEM=1` — local target writes the three keys and a
  subsequent `git commit` is authored `<user>@singularity.invalid`; re-running is
  a no-op; a publish target with our marker removes the keys and refuses.
  `./equin test plugins/infra/plugins/git/plugins/remotes`.
- Extend `plugins/upstream/e2e/clone-journey.ts`: run its clone with an empty
  global config, drive a local push commit and an upstream merge — both succeed
  with the placeholder; the author-side (publisher) assertion with an empty
  global config gets the refusal.
- `./equin check` (boundaries, type-check, docs in sync).
