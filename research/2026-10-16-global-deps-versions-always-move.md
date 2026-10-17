# Dependency versions always move: npm updater, no unnoticed pins, holds that expire, line-level formatting

Status: **plan — model agreed 2026-10-16: lockstep groups + expiring holds (≤90 days, inert on expiry) + blocked moves asked in the upgrade task; line-level formatting.**

## Context

Nothing guarantees a dependency version ever moves forward:

- The `deps-upgrades` automation (`plugins/infra/plugins/deps/plugins/updates`)
  runs only the `mise` and `uv` updaters. `infra/deps/CLAUDE.md` lists the npm
  updater under *Not done yet*. An npm version moves only when someone edits a
  `package.json` or happens to regenerate `bun.lock`: `tailwindcss` is declared
  `^4.1.4` and locked at 4.2.2 (4.3.1 is out); `vite` is `^6.3.2`, so it can never
  reach a new major.
- Exact pins go unnoticed and are never revisited. Across the workspace
  `package.json`s (sidequests excluded): 169 caret, 5 tilde, 5 `latest`, **17 exact**.

The user's rules: packages declare ranges; updates arrive without anyone
remembering; even a version that must be held has a **structural** path forward;
Prettier is not pinned, because formatting is incremental.

### What the exact pins actually protect

Reading the commits that introduced them, the 17 pins come down to **four**
reasons. Only one of them is a real "do not move":

| Pin | Why (from history) | Real constraint |
|---|---|---|
| `@typescript-eslint/{eslint-plugin,parser,utils}` 8.59.2 | `8dae82bd2b`: the root and a plugin resolved two copies whose types do not assign to each other | **coherence**: the three resolve to ONE version, ONE copy |
| `@embedded-postgres/*` ×4 18.3.0-beta.17 | 4 platform optionalDependencies | **coherence**: the four agree; PG `major.minor` = pg-client's |
| `@equin/pg-client-*` ×4 18.3.0 | `database-client-tools:version-matches-server` | **coherence** + a **prerequisite**: the user must *publish* the matching client before the server can move |
| `@equin/pgbouncer-*` ×4 1.25.7 | 4 platform packages (self-published) | **coherence**: the four agree |
| `babel-plugin-react-compiler` 1.0.0 | `8741485d19`: no reason given | none, it was pinned by habit |
| `prettier` 3.9.6 | prettier auto-format plan, step 1: a bump must not reformat the repo | **format stability** (requirement 4 removes it) |

The useful insight: **`bun.lock` is already the pin.** A range in `package.json`
plus a committed lock resolves exactly. Nothing moves unless the lock moves, and
the updater is what moves the lock. An exact spec in `package.json` adds nothing
except "the updater may not move this", and that is the thing we are getting rid of.
So each pin becomes the constraint it actually stands for, and an updater
that understands that constraint moves the package.

## Requirement 3: the model (agreed)

Three concepts, each with a structural guarantee. Together they replace "pin".

### A. Lockstep groups (coherence), which always move

A **group** declares "these packages resolve to one version, and that version is
derived from one leader". Examples: the typescript-eslint trio, each platform
quartet, and pg-client ↔ embedded-postgres (`major.minor` mapping).

- Each package keeps a **range** in `package.json`.
- A check (`deps:npm-groups-coherent`) reads `bun.lock` and fails when a
  group resolves to more than one version, or two copies. This replaces
  "pinning so they can't drift" with "asserting they didn't".
- The npm updater plans a group as **one move**: it picks the newest version
  that every member has published (past cooldown), and moves them all. It never
  proposes a partial move that the coherence check would only revert.
- A group whose leader has a release that some member lacks (PG 18.4 is out,
  `@equin/pg-client` 18.4 is not published yet) is a **blocked move**. It is
  reported, never dropped: see C.

Groups are not holds. They have no expiry because they never stop movement.
They only shape it.

### B. Holds: always a reason, always an expiry

> Superseded for single-release holds by
> [2026-10-17-global-deps-bounded-holds-every-updater.md](./2026-10-17-global-deps-bounded-holds-every-updater.md):
> every hold of every updater (npm, mise, uv) now carries a bounded `until`.

A hold means "do not land version ≥ X yet". Today's `UpdaterHold` (skip one
named broken release, with an issue URL) stays as it is. It already expires on
its own: it names a single version, so the next release moves past it.

A **range hold** ("stay below 7") is the new kind, and it is the only kind that
can stall forever. So:

- **`until: <date>` is required, ≤ 90 days out** (type: required field; check:
  `deps:holds-bounded` rejects an `until` more than 90 days after the commit that
  set it, read from `git log`, so the bound cannot be bypassed by editing the date).
- **An expired hold is inert.** It does not fail main. The updater simply
  stops honouring it, proposes the move, and the normal baseline/candidate gates
  decide. If the move still regresses, the upgrade task's agent either fixes it
  or **renews** the hold: a new `until` plus a new reason, in a diff the user
  reviews. A renewal is a decision someone makes. A hold cannot be forgotten.
- **A held move is still detected and listed** in the weekly task
  ("held until 2026-12-01: <reason>"). A hold gates *landing*, never *seeing*.

### C. Blocked moves (prerequisites) are surfaced as work

Some moves need an action the updater cannot take on its own. The main case is
publishing `@equin/pg-client` for a new PG release. A group or hold can declare
a `prerequisite: { describe, … }`. Detection then reports the move as
**blocked: <prerequisite>**, and the upgrade task's text asks the agent to do
the prerequisite (or to file it). So a version that "must be held exactly" still
produces a task every cycle until it moves.

### Why this is a guarantee

Every version falls into one of these cases:

1. Ungrouped and unheld: the updater moves it on the next run (range rewritten
   for a new major).
2. In a group: it moves with the group, or the group is blocked, which is case 4.
3. Held: the hold expires in ≤ 90 days (enforced by a check, measured from git),
   after which it is case 1 or 2, unless someone deliberately renews it in a reviewed diff.
4. Blocked: it is listed in the weekly task as work to do.

None of these cases lets a version sit silently. The only way to get the old
behaviour back would be an exact spec with no declaration, and
`deps:npm-no-exact` rejects that (requirement 1).

### Where declarations live

In the `dependencyPolicy` key of the **`package.json` that declares the
dependency** (implemented choice; the first draft said `deps/index.ts`): the
policy sits next to the spec it shapes, the updater and the checks already read
every workspace `package.json`, and no new collected-dir kind is needed. Zod
validates it (`deps-npm:policy`). The updater and checks read the generic set
and name no package. See `plugins/infra/plugins/deps/plugins/npm/CLAUDE.md`.

## Requirement 1: no pinning by default

`deps:npm-no-exact` (a check in `plugins/infra/plugins/deps/plugins/npm`): every
dependency spec in every workspace `package.json` is `workspace:*`, a `^`/`~`
range, or covered by a declared hold. An exact version, `latest`, `*`, a
git/URL spec, or an `npm:` alias with an exact version fails, with the fix in
the message. The 5 `latest` specs become `^<locked>`. They are unbounded in
intent, but the lock pins them anyway, and `latest` hides majors from the
updater's range logic.

## Requirement 2: the `npm` updater

New sub-plugin `plugins/infra/plugins/deps/plugins/npm` that implements `Updater`
(`plugins/infra/plugins/deps/plugins/updates/core/internal/updater.ts`) and
contributes `UpdaterDeclare`, like `uv-updater`. Mostly it plugs into what exists:

- **`files`**: every workspace `package.json` and `bun.lock`.
- **`detect`**: reads direct deps and their locked versions from `bun.lock`, then
  queries `registry.npmjs.org/<pkg>` (the packument has `versions` + `time`).
  Latest stable past a **3-day cooldown** (same as `UV_COOLDOWN_DAYS`), minus
  holds, grouped. Returns `Outdated[]`, with held and blocked rows tagged (an
  extension of `Outdated`; the task text renders them).
- **`plan`/`apply`**: within range → lock-only move; beyond range → rewrite the
  spec to `^<to>`. Then `bun install` (lock regenerated), and the result is
  verified against the plan, the same way mise's `apply` re-reads the lock.
- **`smoke`**: none at first. The runner's gates already run all checks + tests
  baseline vs candidate. A group may declare a smoke (e.g. start pgbouncer).
- **`holds`**: `{ entries, file }` pointing at the generated deps registry.

The runner already batches every updater into one task, gates baseline against
candidate, retries to confirm, and puts files back on regression. Concern: one
regressing npm package reverts the whole npm batch. The runner already narrows
by updater (`deps upgrade npm --only a,b`), so the agent can bisect. Follow-up:
let the runner bisect automatically if this shows up in practice.

Also: the `playwright-browser` kind's `updates.none: "follows the playwright npm
pin"` becomes true in practice once this lands. Update its wording.

## Requirement 4: Prettier unpinned, formatting is line-level

File-level incrementality already exists: `listChangedFormattableFiles`
(`plugins/framework/plugins/tooling/plugins/format/core/internal/changed-files.ts`)
formats only the merge-base diff. The upgrade itself touches no `.ts`, so a
Prettier bump reformats nothing on the day it lands. What it does do is make
**every later touched file reformat in full**: a one-line edit drags in a
whole-file diff, which is noise in review and creates conflicts with other branches.

Fix: **format changed lines, not changed files** (the `darker` /
`git-clang-format` approach):

1. For each changed file, compute the changed line ranges against the merge-base
   (`git diff -U0`; untracked = whole file).
2. Format the whole file with prettier (whole-file context, so no `rangeStart`
   AST edge cases), then diff original → formatted.
3. Keep only the hunks that overlap a changed range, and apply them.
4. Repeat 2–3 until a fixed point (bounded; a non-converging file throws loudly).

`format-clean` asserts the same predicate through the same function: "applying
the selected hunks is a no-op". The single-implementation rule of the format
plugin is kept. The lint-directive displacement guard runs on the result as it
does today. Generated files are unaffected (`formatGenerated` formats the whole
file, which it owns). Then `prettier` becomes `^3.9.6`, and the npm updater
moves it like anything else.

## Implementation order

1. **Line-level formatting** (format plugin + `format-clean`), then unpin prettier.
   Standalone, and it removes one pin.
2. **npm updater** with detection, cooldown, plan/apply, registered as an
   updater. Groups and holds are read from the collected declarations.
3. **Declarations + checks**: `npmGroup` / `npmHold` in `deps/`, `deps:npm-no-exact`,
   `deps:npm-groups-coherent`, `deps:holds-bounded`. Convert the 17 pins:
   typescript-eslint, pgbouncer and embedded+pg-client become groups;
   react-compiler and the 5 `latest` become `^`. Retire the pin wording from
   `database-client-tools:version-matches-server` (it reads `bun.lock` now, or
   is subsumed by the group's mapping).
4. Task text: render held/blocked rows in `outdatedSections`
   (`updates/core/internal/upgrade-prompt.ts`). Update `infra/deps/CLAUDE.md`
   (remove *Not done yet*) and the client-tools/embedded CLAUDE.md "bump together" text.

## Verification

- `./singularity test plugins/infra/plugins/deps plugins/framework/plugins/tooling/plugins/format`:
  unit tests for range rewrite, cooldown, group planning (incl. blocked),
  hold expiry, and hunk selection plus fixed point.
- `./singularity check`: the new checks are green after conversion. Put an exact
  pin back in a scratch edit and confirm `deps:npm-no-exact` fails.
- `./singularity deps upgrade npm` in this worktree: it should move tailwindcss
  to 4.3.x and propose vite 7 (or whatever is current), with an `upgraded` or
  `regressed` verdict and a receipt.
- Formatting: under a newer prettier, edit one line of a large file, then
  `./singularity build`. Only that hunk changes; `format-clean` is green.
