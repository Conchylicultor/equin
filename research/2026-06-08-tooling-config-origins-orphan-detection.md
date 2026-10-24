# config-origins-in-sync: detect orphaned origin files

## Context

The `config-origins-in-sync` check verifies that every **expected** `config/**/*.origin.jsonc`
exists and matches `defineConfig` defaults, and that every override `.jsonc` carries a
consistent `// @hash`. It does **not** look the other way: any `*.origin.jsonc` on disk that
no descriptor maps to is silently ignored.

This bit us in the config_v2 reorder migration, which moved reorder's origins from
`config/reorder/` to `config/<defining-plugin>/`. The old generated files were left behind,
got committed, and accumulated as dead duplicates — 44 of them had to be deleted by hand.

The codegen already knows the exact set of origin files it should produce
(`renderConfigOriginContent` returns a `Map<relPath, content>`), so the check has enough
information to flag any `*.origin.jsonc` on disk that isn't in that set.

**Scope (per user decision):** the **check flags** orphans only — non-destructive, enforced at
push. No build-side auto-pruning (that would risk deleting a valid origin if a barrel import
transiently fails, since `discoverConfigs` silently swallows import errors). Once the check
fails, the agent/user deletes the listed files.

## Approach

Add an orphan-detection pass to the existing check. It reuses two values the check already
computes — `expected` (the authoritative set from `renderConfigOriginContent`) and
`allConfigFiles` (every git-tracked + untracked file under `config/`) — so no new discovery
or git call is needed.

### File to modify

`plugins/framework/plugins/tooling/plugins/checks/plugins/config-origins-in-sync/check/index.ts`

### Change

After `allConfigFiles` is gathered (the `git ls-files --others --cached -- config/` block,
currently line ~55-63) and **before** the per-override `@hash` loop, add an orphan pass:

- Iterate `allConfigFiles`; keep only entries ending in `.origin.jsonc`.
- For each, derive the path relative to `config/` — the same key shape as `expected`
  (e.g. `conversations/auto-answer.origin.jsonc`). Use
  `relative(configDir, join(root, relFromRoot))` (both `configDir` and `relative` are already
  in scope / imported).
- If `!expected.has(relPath)`, it's an orphan — collect it.
- After the loop, if any orphans were collected, return a single failing `CheckResult` listing
  **all** of them (more useful than first-failure given the 44-orphan incident), with a hint to
  delete them:

```ts
const orphans: string[] = [];
for (const relFromRoot of allConfigFiles) {
  if (!relFromRoot.endsWith(".origin.jsonc")) continue;
  const relPath = relative(configDir, join(root, relFromRoot));
  if (!expected.has(relPath)) orphans.push(relFromRoot);
}
if (orphans.length > 0) {
  return {
    ok: false,
    message: `Orphaned origin file(s) no longer backed by any defineConfig:\n  ${orphans.join("\n  ")}`,
    hint: "These were generated for a config descriptor that was moved or removed. Delete them (`git rm`), then re-run the check.",
  };
}
```

### Notes / rationale

- `expected` keys are relative to `configDir` (built as `${hierarchyPath}/${descriptor.name}.origin.jsonc`);
  `allConfigFiles` entries are relative to the repo root (`config/...`). `relative(configDir, join(root, relFromRoot))`
  normalizes both to the same key space. (Equivalent to stripping the leading `config/`.)
- No new imports: `relative` and `join` are already imported at the top of the file.
- Placing the pass before the existing `@hash` loop keeps the orphan failure surfacing first
  and avoids interleaving the two concerns.
- The check already short-circuits with `if (!existsSync(configDir)) return { ok: true };`
  before `allConfigFiles` is computed, so the orphan pass only runs when `config/` exists.
- This mirrors the existing check's first-failure-return style but aggregates orphans into one
  message because they are the same class of problem and listing all of them is what the
  manual cleanup needed.

## Out of scope (flagged, not fixed here)

- `discoverConfigs` (config-origin-gen.ts:41-45) silently `catch {}`s barrel-import failures.
  This is the reason build-side pruning is unsafe and is a latent footgun (a broken barrel
  makes a real config look orphaned). Worth a follow-up to make it fail loudly, but not part
  of this change.
- The same orphan-accumulation problem exists for `generatePluginRegistry`'s `*.generated.ts`
  and `generatePluginDocs`'s per-plugin `CLAUDE.md`. Not in scope for this task.

## Verification

1. Baseline: `./equin check config-origins-in-sync` passes on the clean worktree.
2. Create a fake orphan:
   `cp config/shell/shell.toolbar.origin.jsonc config/shell/zzz-orphan.origin.jsonc`
   (any path not backed by a descriptor).
3. Run `./equin check config-origins-in-sync` → expect a **failure** whose message
   lists `config/shell/zzz-orphan.origin.jsonc` and the delete hint.
4. `rm config/shell/zzz-orphan.origin.jsonc` → check passes again.
5. `./equin build` (regenerate everything) → check still passes (no real orphans, no
   regression in the existing "expected exists & matches" + `@hash` duties).
