# Worktree checkout cost — is the 77 MB / 8385-file materialization irreducible? (DESIGN / findings)

**Status:** Investigation complete, **fix NOT built**. This is the cost-axis origin
(`task-1783010164482-y7qec2`) that the just-landed `worktree-mutate` host gate
([`2026-07-02-worktree-mutation-host-gate-DESIGN.md`](./2026-07-02-worktree-mutation-host-gate-DESIGN.md))
is explicitly a **backstop** for. It re-validates that gate doc's one inherited-not-proven
Phase-0 assumption: *"the checkout is irreducible — an agent needs a full working tree."*

**Verdict: the assumption is REFUTED.** The per-occurrence `git worktree add` cost is reducible
**~16× uncontended / ~80× under contention** on this platform (macOS/APFS) via a single
directory-granular `clonefile(2)` syscall — a lever the gate doc did not consider (it weighed only
*sparse checkout*, which is genuinely dead here). The gate remains correct as a containment
backstop and for the fallback + remove paths; clonefile is the **origin cure** for the add cost.

---

## TL;DR

- **What an agent modifies is a tiny subtree** — median ~5–8 files, max 72, out of 8475 tracked
  (**< 1 %**; measured across the last 60 commits on `main`). This is the number the gate doc
  asked for.
- **But "fraction edited" is the wrong axis** — the binding constraint is *fraction read by the
  mandatory tooling*, which is **~100 %**. `./equin build` (required every session)
  type-checks the whole tree, cross-plugin `@plugins/*` imports span everything, boundary/codegen
  walk all plugins. `setupWorktree` even seeds `.tsbuildinfo` precisely so the first build
  "type-checks only its own diff instead of the whole tree" (`worktree.ts:39-43`). ⇒ **sparse /
  partial checkout is REFUTED**: a partial tree breaks the build.
- The tree must therefore be **present**, but on APFS it need not be physically **copied**.
  A directory-granular `clonefile(2)` materializes all 8475 files as copy-on-write metadata
  sharing the template's data blocks: **~0.24 s**, and it *stays* ~0.24 s under load 34 because it
  is a metadata-only in-kernel op that never competes for disk write-bandwidth — so it **dissolves
  the launch-vs-reap contention the gate bounds**, not just the base cost.
- **`cp -c` (per-file clonefile) does NOT win** — it recurses and clonefiles file-by-file, paying
  the 8475 per-file metadata ops serially; it is on par with git's own checkout in CPU. The win is
  *only* via the single directory-level syscall.
- **Clean integration is feasible**: `git worktree add --no-checkout` (git owns branch + admin +
  index, ~0.5 s, no file write) → directory `clonefile` the working tree from a warm `main`
  template → `git read-tree HEAD` (~0.25 s) yields a **perfectly clean, fully functional** linked
  worktree. One honest wrinkle (cold git stat-cache → slow *first* `git status`) with several
  mitigations, all off the interactive path.

---

## Measurements (three probes, on `/Users/epot/__A__/dev/singularity`, 8475 tracked files / 72 MB, **box under load ~34/18 cores** — noisy wall-clock, robust ratios/CPU)

### 1. Edit breadth (the gate doc's missing number)
Per-commit changed-file counts, last 60 first-parent commits on `main`: the distribution is
dominated by **1–15 files**; the single largest commit touched **72 / 8475 = 0.85 %**. Agents
modify **< 1 %** of the tree. `plugins/` is 6877 files (81 %); no tracked `node_modules`.

### 2. Materialization cost — checkout vs copy strategies (same 8475-file tree)

| approach | wall (under load 34) | user+sys CPU | note |
|---|---|---|---|
| `git worktree add` (full checkout) | 18.8 s | **2.2 s** | uncontended floor ~3.8 s (prior trace) |
| `cp -c -R` (per-file clonefile) | 14.5 s | **3.1 s** | ~on par w/ checkout — per-file metadata bound |
| `cp -R` (plain copy) | 64.4 s | 7.5 s | writes all 72 MB of bytes |
| **`clonefile(2)` on the directory (1 syscall)** | **0.19–0.24 s** | ~0 | **in-kernel CoW subtree clone** |

The dominant cost of materializing the tree is the **~8475 per-file metadata operations** (inode +
dirent + journal), **not** the 72 MB of bytes: `cp -c` skips the byte-copy yet stays as slow as
checkout, while the single directory `clonefile` — which does the whole subtree atomically in the
kernel — is **80× faster under load, 16× uncontended**, and *contention-immune*.

### 3. Clean git integration (feasibility)

```
git worktree add --no-checkout -b claude-web/<id> <wt> main   # 0.50 s, 0 working files written
clonefile(template/<top-dir>, <wt>/<top-dir>) for each top dir  # ~0.24–1.0 s total
git -C <wt> read-tree HEAD                                      # 0.25 s (index from HEAD, no IO)
=> git status --porcelain == 0 (clean), git diff clean, 8479 files indexed, branch correct
```

The resulting worktree is a normal linked worktree (shared object store via `commondir`, own
branch/HEAD/index). **Wrinkle:** the *first* `git status` took **46 s under load / 2.25 s CPU** —
the clonefile'd files have fresh inodes, so git's cold stat-cache re-hashes all 8475 files (read-IO,
not write). See *Stat-cache* below.

---

## Why each lever lives or dies (stopping-gate discipline)

- **Sparse / partial checkout — REFUTED (gate 2 legitimacy + counterfactual).** The tooling read-set
  is the whole tree and `./equin build` is mandatory; a sparse tree is not a cheaper correct
  worktree, it is a *broken* one. The "agent edits little" fact does not license it.
- **Per-file clonefile (`cp -c`) — REFUTED (probe 2).** Cost is per-file metadata, not bytes; no win
  over checkout. A cache/copy that still pays the per-occurrence cost is containment, not a cure.
- **Directory `clonefile(2)` — the origin cure (probe 2+3).** Attacks cost-per-occurrence at the
  source (16–80×) *and* removes the disk-write monopolization that makes the add collide with the
  reap — the exact contention the gate can only *bound*. This is the "make the wasted work not
  happen" altitude, not "make it not hurt."

---

## Proposed design (fast-path + correct fallback)

### Warm `main` template
Maintain one pinned template worktree at `main` HEAD under
`.claude/worktrees/.template` (or the data dir). Refresh it when main advances — the
**`git.refAdvanced` (main-only) trigger already exists** (`infra/git-watcher`); refresh =
`git -C <template> checkout -q main` (fast-forward touches only the few changed files per push) or
recreate. Single-flight the refresh; a spawn that races a mid-refresh template falls back to real
checkout.

### Spawn fast-path (in the existing `conversations.spawn` durable job — already off the interactive path)
1. `git worktree add --no-checkout -b claude-web/<id> <wt> main` — git owns branch/admin/index.
2. For each top-level tracked entry of the template (skip `.git`): `clonefile(tmpl/<e>, <wt>/<e>)`.
3. `git -C <wt> read-tree HEAD` (or `reset -q HEAD`) — populate index from HEAD; working tree
   already matches ⇒ clean.
4. Existing `.tsbuildinfo` seed + `mise trust` (the clone can even inherit the template's warm
   `.cache/tsbuildinfo` for free).

**Fallback (correctness-preserving):** if the fast-path is unavailable — template missing/stale,
`clonefile` returns non-zero, or the worktree volume ≠ template volume (clonefile is same-volume) —
fall through to today's `git worktree add ... main` inside the same gated slot. **Platform gate:**
`clonefile` is APFS-only; on Linux the analogue is `cp --reflink` (btrfs/XFS) or an overlay mount —
out of scope; those hosts keep the checkout path. The optimization is a *fast-path*, never the sole
path.

### The stat-cache decision (the one real wrinkle — pick in impl)
`read-tree` gives a **correct** worktree but a **cold** stat-cache, so the agent's first
`git status`/`git diff` re-hashes 8475 files (read-IO). Options, cheapest-risk first:

- **(A) Warm it in the spawn job**: run `git -C <wt> update-index -q --refresh` (or one `git status`)
  after step 3. Pays the ~2–4 s read-scan once, **off the interactive path**, and — unlike today's
  checkout — it is *read*-IO that contends far less with the reap's write-heavy removes. Simplest;
  net contention profile still strictly better than checkout. **Recommended default.**
- **(B) Reuse the template's index + `core.checkStat=minimal`**: clonefile the template's admin
  `index` (its stat entries carry the files' mtimes, preserved by clonefile) and set
  `core.checkStat=minimal` so git ignores the differing inode numbers → warm cache, no re-hash, no
  warm-scan. Fastest, but adds a repo-config dependency (broadly safe; used by large monorepos) and
  a one-file admin substitution.
- **(C) Full admin clone** (clone template `.git` file + admin dir, hand-fix `gitdir`/`HEAD`/branch):
  fastest+warmest but the most surgery/fragility. Not recommended unless A/B prove insufficient.

Recommend **(A)** first; measure; escalate to (B) only if the warm-scan is a material job-throughput
cost under real load.

### Remove side (complementary, secondary)
`clonefile` does **not** cheapen `git worktree remove` (still ~8475 unlinks, ~1.2 s). Remove is
background (reap) / rare (manual), and the gate already bounds it. If wanted later: **rename-to-trash
(O(1)) + async batched `rm`** takes the unlink cost off the collision window. Track separately.

---

## Relationship to the `worktree-mutate` gate — keep both (the skill's "prefer both")
- **Gate = boundary invariant / containment.** Still correct: it bounds the *fallback* checkout, the
  *remove* side, and any non-APFS host. Do not remove it.
- **Clonefile = origin fix** for the add cost in the common case. With it, the add stops being an
  18 MB/s-write disk monopolizer and becomes a 0.24 s metadata op, so the launch-vs-reap collision
  the gate bounds **largely stops happening** rather than merely being throttled.

## Verification plan (before promoting)
1. Micro-bench on a **quiescent** box (per the doc-currency rule — current load 34 contaminates
   wall-clock): sweep fast-path vs checkout for add wall + CPU + first-`git status` cost; pick the
   stat-cache option from data.
2. Correctness: fast-path worktree must pass a real `./equin build`, a commit, and a
   `./equin push` dry-run; `git status` clean; diffs correct.
3. Template lifecycle: force a `main` advance mid-flight; confirm refresh + fallback both yield a
   correct worktree at the right base commit.
4. Live: trigger a reap concurrent with several launches; confirm `conversations.spawn` `workMs` no
   longer tracks the checkout and the new fast-path add stays flat under the reap (via
   `get_runtime_profile`).
5. `./equin build` green (all checks) before/after.

## Follow-ups
- File the remove-side rename-to-trash idea if the reap's write-IO remains a contention source after
  the add is clonefile'd.
- Linux `cp --reflink` / overlay analogue if the deployment target ever leaves macOS.
