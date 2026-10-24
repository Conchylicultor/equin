# A compat shim cannot survive a pre-move writer that replaces the name

**Date:** 2026-08-18 · **Category:** global (`plugins/infra/plugins/paths`)

## Context

Every `./equin build` on this host fails its checks step — main's own post-push
auto-build included — so nothing deploys. The failing check is
`paths:no-undeclared-data-dirs`:

```
central-routes.json is a real file; after the layout migration it must be
the compatibility symlink -> state/gateway/central-routes.json
```

### What actually happened

`writeCentralRoutesManifest` (`plugins/framework/plugins/cli/bin/commands/build.ts:165`)
writes the manifest **atomically**: `writeFileSync(tmp)` then `rename(tmp, dest)`. A
`rename` onto a symlink replaces the symlink with a real file — the shim is destroyed by
the first write.

Pre-migration checkouts spell that destination `~/.singularity/central-routes.json` (the
shim); post-migration ones spell it `gatewayState.file(CENTRAL_ROUTES_FILENAME)` =
`state/gateway/central-routes.json`. **90 of the ~105 live worktrees still carry the old
spelling.** `att-1787009905-pnuk` (old spelling) built at 23:03; the root file's mtime is
23:04.

So re-planting the symlink by hand buys minutes. There is no host state to reach and
hold: the writer cannot be changed in 90 stale checkouts, and the shim cannot survive it.

### The claim that is false

`LEGACY_LAYOUT`'s `file`/`dir` arms say a shim is planted *"so a worktree still running
pre-move code keeps reading and writing the same bytes"*
(`plugins/infra/plugins/paths/core/internal/legacy-layout.ts:38-53`). That holds only for
writers that never replace the **name**. It is false for every writer that renames onto
it, unlinks it, or rotates it — and the row cannot state which kind of writer it has, so
nothing catches the mismatch.

`central-routes.json` is simply the first instance to fire. Audited, the rest:

| Row | Pre-move writer | Verdict |
|---|---|---|
| `central-routes.json` | `build.ts` tmp+`rename` | **shim already clobbered** |
| `op-log.jsonl`, `build-progress.jsonl`, `check-progress.jsonl`, `signal-origin.jsonl` | `file-sink` rotation, `renameIfExists(path, path.1)` (`file-sink.ts:63-65`) | **latent** — the next rotation from a stale worktree moves the shim into the `.1` slot and leaves a real file behind it |
| `gateway.pid`, `database.json` | plain `writeFileSync` (`launcher/server/internal/boot.ts:336,398,525`) | safe — writes through the link |
| `secrets.json.enc` | tmp+`rename`, but the only writer is the central singleton, which always runs main's current code | safe — no pre-move writer exists |

### Two more findings

- **The migration is currently wedged.** Re-running `migrate-data-layout.ts --apply`
  emits `blocked / discard-destination` for this row (`planFileApply`, destination
  occupied), and one blocked step stops the **whole run** — so every other row is stuck
  behind it too.
- **Pushes are unaffected** (`scope: "deploy"`, and `push` runs `--scope tree`), and the
  failure is unrelated to `d0576b2a0`, the commit it surfaced under.

### Outcome intended

The wrong state stops having a spelling: a row that cannot keep a shim can no longer
claim one, and a shim a pre-move writer already replaced becomes a mechanical repair
instead of a run-stopping collision. Nothing is added to `LEGACY_LAYOUT` — one existing
row is reclassified, and the table stays self-liquidating.

## Design

### 1. The table states what pre-move code does to the name

Rename the `transient` arm to `unshimmable` — its real meaning is *"no shim can hold
here"* — and make it carry the fact that decides everything downstream:

```ts
| {
    from: string;
    move: "unshimmable";
    to: DataDirRef;
    /**
     * What pre-move code leaves at the root once it has written.
     *  - "nothing" — it creates and unlinks (duress.latch, push-holder.json)
     *  - "a file"  — it REPLACES the name (tmp + rename), so a real file sits there
     */
    leaves: "nothing" | "a file";
    reason: string;
  }
```

`transient` was already the right *shape* — both existing rows are "a shim would be
removed by the first clear/release" — but its name describes the file's lifetime, and
`central-routes.json` is permanent at the root. `leaves` is the honest discriminator, and
every consequence derives from it rather than being written out:

- **Expectation** (`legacyRootEntries`): `"nothing"` → `{kind:"absent"}` (today's
  behaviour, unchanged); `"a file"` → a new `{kind:"absent-or-file"}`.
- **Shim planted**: never (`rowIsShimmed` already returns `false` for this arm).
- **`apply`**: for `leaves:"a file"`, plan `unlink` of a **symlink** left at the root, so
  the steady state is one thing (absent or a plain file) rather than three. It only ever
  unlinks a link — no bytes can be lost.
- **`drop-legacy`**: unchanged — unlink whatever sits there.

The row (reclassification, not an addition):

```ts
{
  from: "central-routes.json",
  move: "unshimmable",
  to: "state/gateway",
  leaves: "a file",
  reason:
    "the build writes the manifest atomically (tmp + rename), and a rename onto the shim " +
    "replaces it with a real file — so the shim cannot survive the first stale-worktree " +
    "build. For one release cycle a stale worktree's build refreshes a manifest nothing " +
    "reads: the gateway is handed -central-routes-file explicitly and reads only " +
    "state/gateway/central-routes.json, so a central route added or removed by a stale " +
    "checkout is not routed until a current-code build runs.",
}
```

`duress.latch` and `push-holder.json` become `move: "unshimmable", leaves: "nothing"`,
reasons unchanged.

### 2. A clobbered shim is a repair, not a collision

For rows that legitimately keep a shim (the four rotating log families, every `dir` row),
`planFileApply` must tell the two causes apart by evidence it already has:

- **Some slot of the family holds a symlink pointing INTO this family's destination** ⇒
  pass 1 ran for this row (only pass 1 plants one), so a real file at the root is
  post-migration debris a pre-move writer left → **rescue and re-plant**:
  1. `rename(<name> → <kind>/<name>/<name>.pre-move-<n>)` — beside its family, under a
     name that says where it came from; `<n>` is the first free index, read off the
     destination's `children` the planner is already handed. Never merges, never deletes,
     never picks a winner.
  2. `symlink(<name> → <kind>/<name>/<name>)` — re-plant the shim.
- **No shim anywhere in the family** ⇒ the original pre-migration collision, which looks
  identical on disk. `blocked / discard-destination` keeps its current meaning and its
  numbers. Judged as a FAMILY (the unit `preconditionViolations` already uses) and not
  per-slot, because a rotation shuffles every slot's link one place along, so afterwards no
  slot holds its own target. A `keep: 0` row has one slot, so a clobber there leaves no
  evidence and falls to `blocked` — the cautious side, since the only other reading is that
  the file is the original.

  *(Implementation note: an earlier draft used "the destination already holds the canonical
  file" as the discriminator. That is wrong — it is equally true of the live pre-migration
  collision this check refuses on, where new code had written the destination while the
  history sat at the root. The family's own shim is the only evidence that separates them.)*

Rescued files sit *inside* a declared `<kind>/<name>` directory, which rule 3 does not
police (it polices the directory's name, not its contents) — no new check surface.

A **rotated shim** (`op-log.jsonl.1 → logs/op-log/op-log.jsonl`, i.e. a link whose target
is another slot of the same family) is today `blocked / inspect`. Same treatment: it is a
link, so `unlink` + re-plant the slot's correct shim loses nothing. A symlink pointing
anywhere else stays `blocked / inspect`.

### 3. The check names the repair

`verifyLegacy` gains the `absent-or-file` arm (a directory still fails — the table says
file; a symlink fails and says `--apply` will drop it, since the shim cannot hold here).
For a shimmed row found as a real file or a misnamed shim, the message says a pre-move
writer replaced the shim and names the dry-run-then-`--apply` repair, rather than today's
"the migration has not run" — which will be the wrong diagnosis from now on.

### Not changed

No name is added to `LEGACY_LAYOUT`; the drained tally still counts `central-routes.json`
as un-drained until it leaves the root, so the to-do stays honest and self-liquidating.

## Files

- `plugins/infra/plugins/paths/core/internal/legacy-layout.ts` — the arm + `leaves`, the
  `central-routes.json` row, `LegacyExpectation`, `legacyRootEntries`, `rowIsShimmed`,
  `planRowApply` / `planFileApply` / `planRowDrop`, and the `transient` mention in
  `planningOrder` (~line 564).
- `plugins/infra/plugins/paths/check/index.ts` — `verifyLegacy`'s new arm, the shimmed-row
  failure message, and the hint's "a real directory means the migration has not run" line.
- `plugins/infra/plugins/paths/scripts/migrate-data-layout.ts` — the dry-run printer
  switches on `row.move` (~172) and on step actions (~199, ~389); add the new arm and the
  rescue step's line.
- `plugins/infra/plugins/paths/core/internal/legacy-layout.test.ts` — two tests use
  `file("central-routes.json")` as the generic shimmed-file fixture (~lines 310, 329);
  switch them to `database.json` (`move: "file"`, `keep: 0`, `state/db-config`, no
  interacting row). New cases: `leaves:"a file"` expectation (absent ✓, file ✓, dir ✗) and
  its stray-shim unlink; rescue-and-re-plant with a populated destination, idempotent on
  re-plan; `blocked` preserved when the destination is absent; rotated-shim unlink +
  re-plant.
- `plugins/infra/plugins/paths/CLAUDE.md` — the shim's precondition (~lines 76-79): a shim
  is planted only where no pre-move writer replaces the name.

## Verification

1. `./equin test plugins/infra/plugins/paths` — the planner is pure, so the arms,
   the rescue, and idempotency are all covered by unit tests.
2. `bun plugins/infra/plugins/paths/scripts/migrate-data-layout.ts` — dry run, read-only.
   Expect **no** `blocked` step for `central-routes.json`, and the rest of the table
   planned again (it is currently wedged behind that one row).
3. `./equin check paths:no-undeclared-data-dirs` — green against the host's current
   disk state, with **no manual repair**: the root real file + `state/gateway/…` is
   exactly what the reclassified row expects. (If single-id invocation filters by scope,
   step 4 exercises it.)
4. `./equin build` (background, per CLAUDE.md) — expect `BUILD OK` and
   `~/.singularity/worktrees/att-1787088003-13gq/build-status.json` at `status: ok`.
5. Confirm it holds under the thing that broke it: after any stale worktree builds again
   (`~/.singularity/central-routes.json` mtime advances), re-run step 3 — still green.
6. Sanity: `ls -la ~/.singularity/central-routes.json ~/.singularity/state/gateway/` and
   the gateway's `central routes loaded` line in `~/.singularity/logs/gateway/gateway.log`
   — the gateway keeps reading `state/gateway/central-routes.json` only.
