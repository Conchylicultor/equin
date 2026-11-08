# What a new checkout's dependency install really writes

Task: task-1794174270 (responsiveness audit, supervisor task-1793965642-94fdhj).
Follows research/2026-11-08-global-worktree-tree-recycling.md, which put the
install onto an adopted dependency store (`dep-store-pool.ts`) at ~12.4k
entries per checkout ("each store entry's own dependency links") and called it
the largest per-checkout write left. The task was to make it O(lock changes)
by keeping a checkout's whole `node_modules`, with a prune of dropped links.

## Finding: the install is ~0.7–0.8k entries, not 12.4k

Nothing reproduces 12.4k. bun 1.4.4 does **not** rewrite the store's internal
links (`node_modules/.bun/<pkg>/node_modules/<dep>`) when they are already
right; it writes the top-level and workspace links plus the packages the lock
changed.

Counted as entries whose ctime falls in the install's window (`os.lstat`,
every entry under every `node_modules`, and their parent dirs).

**Real checkouts on main** (`worktree-prepare`: "dependency store adopted",
store from a checkout made ~72 h earlier, `./equin install` frozen):

| checkout | root `node_modules` changed / total | workspace `node_modules` changed | install |
| --- | --- | --- | --- |
| att-1794155323-51wlja | 312 / 76.0k | 353 | — |
| att-1794161298-ze7avt | 311 / 76.0k | 353 | — |

Of the 311: 57 top-level links, 13 top-level scope dirs, ~200 files inside
store packages the lock added, ~25 store links of those packages.

**Scratch clone** (`git clone --shared`, bun 1.4.4):

| case | entries changed | time |
| --- | --- | --- |
| whole `node_modules` kept, same lock | 0 | 0.4 s |
| only `.bun` kept, same lock, same path | 518 (69 root, 355 workspace, 94 parent dirs) | 0.4 s |
| same, store moved to another checkout path | 518 | 0.4 s |
| only `.bun` kept, store from main − 72 h (5 packages added) | 792 (+274 store) | 0.7 s |
| same through `./equin install` (postinstall provisions included) | 800 | 2.1 s |

**The full recycled-checkout path** (tree + store at main − 72 h → HEAD, as
`tree-pool.ts` + `dep-store-pool.ts` do): `git reset --hard` 4,307 entries,
`git clean -ffdx` 566 deleted (423 of them the old checkout's `node_modules`
links), install 800. Dependencies are ~1.2k of ~5.7k entries per checkout.

## Decision: no change

- Keeping `node_modules` whole would save at most the links (~420 deleted by
  `clean` + ~520 rewritten ≈ 0.95k per checkout, ~17 %); the store entries the
  lock adds are written either way.
- It is not free: the tree pool and the store pool become one entry (a tree
  without its store, a store without a tree), and the prune must derive every
  expected top-level and workspace link from `bun.lock` — the correctness bar
  (a dropped dependency must not stay importable) rests on that derivation
  matching bun's linker exactly.
- The larger cost per checkout is the tracked-tree diff (~4.3k for a 72 h-old
  tree), which is the files that actually changed on `main`.

Worth revisiting only if a measurement of fseventsd load after the tree pool
fills (tree-recycling doc, "Not changed") shows the ~1k link entries matter.
