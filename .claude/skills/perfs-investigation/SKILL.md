---
name: perfs-investigation
description: >
  How to investigate and fix performance issues. Read BEFORE any perf investigation,
  profiling pass, or perf fix. Perf is nested layers: split the cost, recurse into the
  biggest part until you understand why it happens, and fix that — never hide it.
---

# Performance investigation

**Performance is nested layers.** "The page is slow" → which part? Split it into its
sub-parts, measure each, recurse into the biggest: why is *that* part slow? Keep going until
you understand why the work happens at all — not just where the time is spent.

Start from the whole event: Debug → Reports and the Timeline (`get_timeline`), then measure
(`benchmark_boot`, `get_runtime_profile`) — see the [`debug`](../debug/SKILL.md) skill.

## Principles

- **Understand the issue fully**, so you fix the right thing instead of patching around it.
- **A fix must never hide the deeper issue.**
- **Target the biggest cost first.** Don't optimize what doesn't dominate.
- Every cost is **how often × how expensive**. Ask both: why is one occurrence slow, *and*
  why does it run this often? Work that changes nothing (a no-op write, an unchanged
  recompute) should not happen at all — not happen more cheaply.

## Fixes that hide a structural issue

- **Caching over a slow path.** Target the cold case. A cache is fine as a complement once
  the path is sound, never as the thing that hides why it is slow.
  - Global, all-or-nothing invalidation is bad unless the recompute is O(1): a fingerprint
    that recomputes the whole table on any change is O(N), and if it is invalidated often,
    it is as if there were no cache.
  - Good: recompute only what changed — O(changes).
- **A deadline on a slow op** → find out why the op is slow.
- **A retry on a failing op** → find out why it fails.

The rules are examples; the philosophy is what matters: a fix that makes the symptom
disappear without explaining its cause is a workaround hiding a deeper issue.
