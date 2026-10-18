# remotes

Two questions about this checkout's remotes, answered the same way by the CLI
and by the server — plus one that follows from the first:

| You want | Use |
|---|---|
| May this checkout publish its work, and to which remote? | `resolvePublishTarget(root)` |
| Which remote does it receive changes FROM? | `resolveUpstreamRemote(root)` |
| Who signs the commit I am about to make? | `ensureCommitIdentity(root, target)` |

It sits under the `git` umbrella — "has git state moved, and must I read it
again?" — because that is the shape of the answer: a measurement, taken once and
re-taken when the thing it measured moves.

## Publishing is a capability, not a mode

There is no author/user flag, and nothing to set when you clone. Only the remote
can say whether you may write to it, so we **ask it** — once — and write down
what it said.

The question is asked as `git push --dry-run --force <remote> HEAD:refs/heads/singularity-write-probe`.
`--dry-run` does everything except send the update, and "everything" includes
opening the session and requesting `receive-pack`, which is where every hosted
forge decides whether this identity may write. Three details are load-bearing:

- **The ref is not `main`.** Pushing `main` asks two questions at once, and git
  answers the second one — "is my main a fast-forward of yours?" — locally,
  before permissions ever come up. An author whose local `main` sat one commit
  behind would fail that check and be filed as read-only, switching their own
  publishing off. A ref nobody has raises no such question.
- **`--force` is inert here.** Under `--dry-run` there is no update to force; it
  is present only to drop the remaining client-side checks, so the probe can
  only fail for reasons that come from the remote.
- **`GIT_TERMINAL_PROMPT=0`** (and `BatchMode=yes`, when the user has not set
  their own `GIT_SSH_COMMAND`) is the difference between a probe and a hang: git
  would otherwise ask for a username on the terminal, with this child's output
  going to a capture file where nobody would see the question.

## "No" is four different facts

A failed probe is classified, not collapsed, and only **one** of the four is
recorded:

| outcome | what it means | recorded? |
|---|---|---|
| `read-only` | the remote recognised us and refused the write | **yes** |
| `no-credentials` | the remote never learned who we are (a key it does not accept, a prompt we suppressed) | no |
| `unreachable` | nobody answered — DNS, the network, or our own deadline | no |
| `probe-failed` | git failed for a fourth reason; we print its words rather than pick the nearest label | no |

Recording an unreachable remote would write down something nobody said, and
every later push would tell the user they may not publish because their wifi was
off once. Recording a rejected ssh key would turn a fixable credential into a
permanent verdict. Both stay local **for that run only**, and say so.

The classification order is the whole design, because git prints the specific
cause and the generic consequence together, and the generic line is identical
for causes that mean opposite things:

```
ssh: Could not resolve hostname github.com: …      <- unreachable
fatal: Could not read from remote repository.

git@github.com: Permission denied (publickey).     <- no credentials
fatal: Could not read from remote repository.
```

So the specific causes are tested first, `unreachable` before `no-credentials`
before `denied`, and the shared line is matched by nothing. The samples in
`classify.test.ts` are verbatim git output, including that tail.

**`classifyRemoteFailure(capture)` is exported**, because a failed `fetch` asks
the same question a failed push probe does — `upstream status` reads it to tell
an offline laptop from a real error. It answers only about a FAILURE and throws
on a capture that succeeded: "you may publish" is a publish-only conclusion and
is drawn by the prober, not by the shared table. `denied` therefore means "the
remote refused the operation" — write access for a probe, read access for a
fetch.

## Why the answer lives in `.git/config`

```
singularity.publish.remote = origin | none
singularity.publish.url    = <the URL that answer was probed for>
```

Same tier and the same shape as `core.hooksPath` (which `build` self-heals) and
the merge drivers: one file per clone, untracked, shared by every worktree of
it, readable with no server running. `git config --local` from a linked worktree
reads the clone's config, not a per-worktree one, which is exactly the scope
wanted.

**It is a cache of a measurement, not a setting** — that is why it is not a
`config_v2` value. A user-editable "may I publish" field would be a claim the
remote can contradict, and does, every time it refuses a push.

It is re-probed when:

- the recorded URL is not the remote's current URL, character for character. A
  user who re-points origin from https to ssh has changed how they authenticate
  to it, which is the input to the recorded answer — so the cheap thing is to
  ask again. (This exact-text rule is deliberately *not* the normalised repo
  identity used against `CANONICAL_REPO_URL`.)
- a **real** push is rejected — `recordPushRejection(root)`. That rejection is
  newer evidence than the cache: it is the remote answering the exact question
  the cache holds a guess at. A checkout that loses its write access therefore
  heals itself into local mode on the next push instead of failing forever.
- the user asks: `git config --local --unset singularity.publish.remote`, which
  the printed local-only line names.

## Upstream falls out of the same facts

1. a remote literally named `upstream` — the user has already said so;
2. else we cannot publish, so the remote we cannot write to **is** upstream (the
   ordinary clone: one remote, read-only);
3. else we publish somewhere that is not `CANONICAL_REPO_URL`, which is a fork —
   add `upstream` pointing at the canonical repo and use it;
4. else we publish to the canonical repo, so this is the author's checkout and
   there is nothing above it (`{ kind: "none", reason: "is-publisher" }`).

Step 2 deliberately includes `unreachable`: a remote we could not reach today is
still the remote this checkout came from. That failure belongs to whoever
fetches, not to a claim that there is no upstream at all.

`CANONICAL_REPO_URL` is also in `CITATION.cff`; deduplicating the two belongs to
whoever adds the README that reads both.

## Commit identity is decided at commit time

A fresh install sets no `user.name` / `user.email`, on purpose: in a clone the
identity never leaves the machine, so asking for it at install would be a step
with nothing to show for it. Left alone, git signs with `login@hostname` — junk
that goes public the day the checkout publishes — or, on a hostname with no
domain, refuses to commit at all.

So the two commands that make commits (`push`, `upstream merge`) call
`ensureCommitIdentity` with the publish target, before the commit:

| identity \ target | `local` | `publish` |
|---|---|---|
| explicit (any config scope, or `EMAIL` / both `GIT_*_EMAIL` in the env) | use it | use it |
| missing | write a `--local` placeholder: git's own derived name, `<login>@singularity.invalid` | **refuse**, with the `git config --global` commands |
| ours (the placeholder, still unchanged) | use it | remove it, re-read; explicit ⇒ use it, else **refuse** |

"Ours" is recorded as `singularity.autoIdentityEmail` and only counts while the
local `user.email` still equals it, so a user who sets their own local email
has taken it over. The `.invalid` TLD is reserved (RFC 2606): the placeholder
can never route anywhere or leak the hostname. The refusal tells an agent to
ask the user — an identity is the one value it must never invent. The rule
itself is the pure `decideIdentity`, tested cell by cell.

## Boundaries

`core/` here means **runtime-neutral Node, not web-safe** — every module behind
the barrel spawns `git` through `infra/spawn`. Never import this from `web/`.
It is a pure library: a `core/` barrel with no plugin definition and no
contributions, like `plugin-id`.

`gitConfigGet` / `gitConfigSet` / `gitConfigUnset` live here as the one spelling
of a `--local` config read or write; `git-artifacts`' merge-driver registration
imports them rather than keeping its own copy.

## A directory is never a publish target

A remote that is a directory on this machine (a path, or `file://`; decided by
`remoteTransport`, which is git's own `url_is_local_not_ssh` rule) is **not
probed**. `git push --dry-run` into a directory is answered by a local
`receive-pack` that writes nothing, so it says yes to pushes the real one refuses
(a checked-out branch, a read-only mount) — and to pushes it would accept, which
would write a clone's work into someone else's checkout. Such a checkout is
`local` with reason `filesystem-remote`: `push` lands on its own `main` and
pushes nothing. Not recorded — the URL is the whole answer.

Hosted forges (GitHub, GitLab, Gitea) decide at the service request, which the
probe does reach, so for them the probe is the answer. What a probe cannot see —
access lost later — is covered by `recordPushRejection`: the first real push
that fails re-probes and records what comes back.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: May this checkout publish, and where does it receive from? — the write-access probe (`git push --dry-run`, classified into denied / no-credentials / unreachable rather than one 'no'), its `.git/config` cache of that measurement, the upstream resolution built from the same facts, and who signs the commits push makes (a local placeholder where they cannot leave the machine, a real identity required where they will be public).
- Core:
  - Uses:
    - `infra/spawn.spawnCaptured`
    - `infra/spawn.spawnExpectOk`
  - Exports (types):
    - `CommitIdentity`
    - `LocalReason`
    - `PublishTarget`
    - `RemoteCapture`
    - `RemoteFailure`
    - `UpstreamRemote`
  - Exports (values):
    - `CANONICAL_REPO_URL`
    - `classifyRemoteFailure`
    - `describeAutoIdentity`
    - `describePublishTarget`
    - `ensureCommitIdentity`
    - `gitConfigGet`
    - `gitConfigSet`
    - `gitConfigUnset`
    - `PUBLISH_REMOTE`
    - `recordPushRejection`
    - `remoteUrl`
    - `resolvePublishTarget`
    - `resolveUpstreamRemote`
    - `sameRepoUrl`
- Cross-plugin:
  - Imported by: `upstream`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/internal/commit-identity.ts`, `core/internal/publish-target.ts` (debt)

<!-- AUTOGENERATED:END -->
