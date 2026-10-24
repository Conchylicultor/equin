# file-sink: core placement + a bounded read counterpart

## Context

`./equin check type-check` currently fails with one ESLint violation:

```
plugins/framework/plugins/tooling/plugins/checks/core/progress-log.ts:1:10
  sink-safety/no-adhoc-file-sink
```

`progress-log.ts` (added in `bd7966884`, the durable per-check progress log so a
wedged check run names itself) imports `appendFileSync` and hand-rolls its own
retention: `prune()` trims to 2,000 lines once the file passes 5 MB, via
write-then-rename. The rule bans exactly this — a durable append-only file
invisible to `getFileSinks()`, whose bound is a comment rather than a property of
the writer.

**The rule is right, and the author had no legal alternative.** `defineFileSink`
is exported from `@plugins/infra/plugins/file-sink/server`, but `progress-log.ts`
lives in `checks/core/`. Runtime isolation
(`plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts:9-15`)
says `core: ["core"]` — a core file may import only core. **The sanctioned
chokepoint is unreachable from the runtime that needed it**, so the only escapes
are hand-rolling the append or adding a lint allowlist entry (the rule's
`ignores` list already carries two). `file-sink`'s own CLAUDE.md claims "Node-only
… a short-lived CLI process (no server, no DB) can import it" — a contract its
`server/` placement contradicts. The CLI check runner *is* that process.

The intended outcome is that the violation disappears because the workaround
became unnecessary, not because it was allowlisted — and that the next tooling
author hits a reachable chokepoint instead of the same wall.

A second gap surfaced while scoping: `FileSink` owns `append()` but has no
reader, so every consumer hand-rolls JSONL reading and **none know rotated
`path.N` files exist**. The worst instance is a live bug:
`op-log/server/internal/read.ts:29-33` reads three files whole via
`readFileSync` on every Debug→Profiling Gantt request, one of which is a sink
capped at the default **128 MB × 3**, with no line cap and no time window.

## Why the move is safe

- The impl (`file-sink/server/internal/file-sink.ts`) imports **only** `node:fs`,
  `node:path`, and its own `core` types — exactly the dependency profile `core/`
  permits.
- **50 `core/` files already import `node:fs`** (plugin-tree, codegen,
  boundaries, guards, web-artifacts, checks). `core/` in this repo means
  *runtime-neutral*, not *web-safe*.
- `file-sink` has no `web/` dir and no web consumer; its only `core` importers
  today are type-only.
- The blocking check is `boundary-rules`
  (`plugins/framework/plugins/tooling/plugins/boundaries/core/check.ts`), which
  inspects only `@plugins/…` / `@core/…` specifiers — it does not gate `node:*`.
- Verified as **not** tripping: `plugin-boundaries`, `no-reexport-default` (scans
  only `web|server|central/index.ts`), `collected-dir-tsconfig-coverage`,
  `pre-barrel-manifests-complete`, `plugins-registry-in-sync`,
  `durable-signals-accounted` (scans only `defineLogSink`).
- `no-adhoc-file-sink` exempts by substring `plugins/infra/plugins/file-sink/` —
  the whole plugin dir — so the impl stays exempt wherever it lands inside it.

## Step 1 — move the impl to `core/`

| From | To |
|---|---|
| `plugins/infra/plugins/file-sink/server/internal/file-sink.ts` | `core/internal/file-sink.ts` |
| `plugins/infra/plugins/file-sink/server/internal/file-sink.test.ts` | `core/internal/file-sink.test.ts` |

In the moved impl, switch the self-referential alias import to a relative sibling
(`from "./types"`) — after the move it would otherwise cycle through the barrel
that re-exports it. `persist.ts` importing `./registry` is the in-repo precedent.

`core/index.ts` becomes the **only** export site:

```ts
export type { FileSink, FileSinkSpec, RotateBound } from "./internal/types";
export { defineFileSink, getFileSinks, openDynamicSink, sanitizeChannel } from "./internal/file-sink";
export { readTail, readJsonlTail } from "./internal/read";
export type { TailOptions, TailResult, JsonlTailResult } from "./internal/read";
```

`server/index.ts` keeps **only** its default `ServerPluginDefinition` export — no
proxy re-exports (the repo forbids proxy barrels and wants one import path per
symbol). It must keep existing: `server.generated.ts:221` dynamically imports it
and op-log / retention / log-channels list it in `dependsOn`.

**Export `sanitizeChannel` now.** `persist.ts:17-19` carries a hand-copy whose
comment says the regexes must stay identical *because file-sink doesn't export
one* — a comment that exists only because the symbol was stranded behind
`server/`. Both are `/[^A-Za-z0-9_-]/g` (verified byte-identical), so the
duplicate can go in step 5.

### Call sites to update (`/server` → `/core`)

1. `plugins/debug/plugins/profiling/plugins/op-log/server/internal/jsonl.ts:3`
2. `plugins/primitives/plugins/log-channels/server/internal/log.ts:2`
3. `plugins/primitives/plugins/log-channels/server/internal/client-ingress.ts:2`
4. `plugins/infra/plugins/retention/server/internal/growth-bounds.ts:1`
5. `plugins/infra/plugins/retention/server/internal/growth-bounds.test.ts:5`

(`log-channels/server/internal/registry.ts:1` already targets `/core`, type-only.)
All are `server → core`, permitted by `runtimes.server`.

`getFileSinks`'s growth-bound mechanism is unchanged — `growth-bounds.ts` changes
one import path and keeps merging each sink's `bound` under `file:${id}`.

## Step 2 — lift the bounded reader into `core/internal/read.ts`

**Do not invent a reader.** `log-channels/server/internal/persist.ts:78-121`
already has the right one: `readTail` does a positioned
`openSync`/`fstatSync`/`readSync` of the last `READ_TAIL_BYTES` (8 MB, line 41)
so "even a full (≤128 MB) live file is never materialized whole into memory",
dropping the leading partial line when the read didn't start at offset 0. Lift
that algorithm, generalized off the log-channel envelope.

```ts
export interface TailOptions {
  /** Byte budget pulled off disk. Default 8 MB. */
  maxBytes?: number;
  /** Cap on returned lines (newest kept). Default unbounded within the budget. */
  maxLines?: number;
  /** Walk `path.1`, `path.2`, … until the budget is met. Default false. */
  includeRotated?: boolean;
}

export type TailResult =
  | { kind: "missing" }
  | { kind: "read"; lines: string[]; truncated: boolean; filesRead: number };
```

`readJsonlTail<T>(path, opts)` layers tolerant per-line `JSON.parse` on top
(`SyntaxError` → skip, anything else rethrows) and returns `records: T[]`.

**Free functions *and* `FileSink` methods.** The free form is mandatory: op-log
reads two *frozen legacy files* (`push-contention.jsonl`, `build-log.jsonl`) that
have no sink object and must never get one — declaring a `rotate` bound for a
file nothing writes would be a false entry in the growth-bound registry. The
method form (`sink.readJsonlTail()`) removes the chance to read a sink from the
wrong path, and both current call sites already declare sink and reader in one
module, so it is the natural local call.

**No zod in file-sink.** Its defining property is importing nothing but
`node:fs`/`node:path`; that is what makes it CLI-importable and safe in `core/`.
Schema validation stays at the caller (`persist.ts:readChannelJson` keeps its
`safeParse`-drop layer).

**Rotation stitching is opt-in, default off.** `persist.ts`'s "rotated files are
cold, don't stitch" position is correct *for a tail* and wrong for a
*reconstructing* reader like `readCheckProgress`. Default-off keeps every
migrating caller byte-for-byte behavior-preserving and makes each stitch a
documented per-caller decision. Walk live → `.1` → `.2`, concatenate oldest-first
so line order stays chronological; drop the leading partial line only for the
oldest file opened. Safe because `append()` writes whole lines and rotation
happens between appends — **a line is never split across a rotation**.

**Missing file returns `{ kind: "missing" }`, not `[]`.** Today
`readJsonlLines` and `readCheckProgress` both absorb ENOENT into `[]`;
`persist.ts` gets it right by returning `null`, and its own comment
(lines 132-141) notes that collapsing to `[]` makes "no channel yet"
indistinguishable from "present but empty". Per the repo's absorbed-failure rule,
return the union — callers that want empty write one visible line.

`truncated: true` when the budget clipped history, so a partial window can never
be presented as complete.

Defaults: `maxBytes` **8 MB** (deliberately matching `READ_TAIL_BYTES`, so
`persist.ts` can later collapse onto this with zero semantic change);
`maxLines` unbounded. Do **not** derive the budget from `sink.bound.maxBytes` —
that yields a 512 MB default for a default sink.

New `core/internal/read.test.ts`, mirroring `file-sink.test.ts`'s hermetic
`mkdtempSync` pattern: under-budget read, over-budget drops the leading partial
line and sets `truncated`, missing → `{kind:"missing"}`, torn trailing line
skipped, non-`SyntaxError` rethrown, `includeRotated` stitches oldest-first
across a forced rotation, `maxLines` keeps the newest.

## Step 3 — `progress-log.ts` onto the sink

`plugins/framework/plugins/tooling/plugins/checks/core/progress-log.ts`:

1. **Delete the `fs` import** — this is the line the rule reports on.
2. Delete `MAX_BYTES`, `TRIM_TO_LINES`, `prune()`, and the `prune()` call.
3. Declare the sink at module scope with **explicit, non-default bounds**:

```ts
const progressSink = defineFileSink({
  id: "check-progress",
  description: "Per-check-run progress log …",
  path: PROGRESS_FILE,
  maxBytes: 2 * 1024 * 1024,
  keep: 2,
});
```

128 MB × 3 is a firehose budget for a log where a full run is ~155 lines.
2 MB × keep 2 = **6 MB worst case**, versus the ~5 MB `prune()` allows today —
while retaining ~8,000 lines against the current 2,000. Rotation cannot trim
*within* a file, so `keep` is how history is bought back; say so in the comment,
and rewrite the stale "2,000 lines is dozens of runs" note.

4. `writeRecord` → `progressSink.append(JSON.stringify(record))`. Every claim in
   its doc comment survives (`append()` is one synchronous unbuffered `O_APPEND`
   write, atomic under 4 KB, propagates failures) — retarget the comment, keep it.
5. `readCheckProgress` **must** opt into rotation or lose runs at the boundary:

```ts
const result = progressSink.readJsonlTail<ProgressRecord>({
  includeRotated: true,
  maxBytes: 8 * 1024 * 1024, // covers the full 6 MB footprint
});
if (result.kind === "missing") return []; // no run has ever executed here
```

Delete the inline `try`/`JSON.parse`/`SyntaxError` block — `readJsonlTail` owns
it. The existing "a run whose `run` line was pruned away leaves orphan lines"
comment stays true but now means "rotated past `.2`".

Note in a comment: `file:check-progress` appears in `getFileSinks()` only in
processes that evaluate this module (the CLI), not the server where `retention`
runs. That is fine — the bound is true by construction; the registry is a
per-process set for the deferred undeclared-growth monitor.

## Step 4 — migrate op-log

`op-log/server/internal/jsonl.ts`: **delete `readJsonlLines` outright** and drop
the `readFileSync` import; its ENOENT/`SyntaxError` semantics are exactly
`readJsonlTail`'s. Keep the path constants, `opLogSink`, and `appendOpLog`.

`read.ts:readOpRecords` (lines 29-33) uses `opLogSink.readJsonlTail()` for the
live log and the **free** `readJsonlTail(LEGACY_*_FILE)` for the two frozen
files, folding `kind === "missing"` to `[]` explicitly at each site. Default 8 MB
budget per file, no stitching (the Gantt is a recent-ops view): worst case drops
from ~384 MB materialized per request to 24 MB.

`finalizeOrphanedOps` is safe under a bounded read — verified at
`read.ts:66-68`: `orphanedOps` only yields groups carrying a `requested`, and the
`if (!base) continue;` guard skips a group whose head was truncated away rather
than mis-finalizing it. Add a comment, since the bound makes that guard
load-bearing rather than defensive.

## Step 5 — dedup `sanitizeChannel`

In `persist.ts`: delete the local copy, import from
`@plugins/infra/plugins/file-sink/core`, delete the now-false comment at lines
14-16. Verify byte-identity *before* deleting. Leave
`readTail`/`readChannelEntries`/`readChannelJson` alone — `persist.ts` is
imported by 20+ plugins and its collapse is deliberately out of scope.

## Deferred (file as a task, do not do here)

- **`persist.ts` collapse.** Once `readJsonlTail` exists, `readTail` reduces to
  it with `{ maxLines: tail }` and `kind:"missing"` mapped to the `null` callers
  already handle; `tryParseEntry` deletes. Pure deletion — which is the argument
  for matching the 8 MB default above.
- **A `web/` guard for node-only `core/` barrels.** `runtimes.web` permits
  `web → core` and nothing gates `node:*`, so a future web file could legally
  drag `node:fs` into the bundle. Blast radius today is zero (no importer means
  no Vite graph entry), and this change widens an existing hole by one symbol
  rather than creating it — the 50 pre-existing `node:fs` core files are the
  real surface. A general "no `node:*` transitively reachable from `web/`" check
  is the right fix and needs its own design.

## Docs (mandatory, not deferred)

`file-sink/CLAUDE.md`'s "## Boundaries" section currently asserts `core/` is
"Web-safe (no `node:fs`)" — precisely what this change inverts. Replace with:
*`core/` here means runtime-neutral Node, not web-safe; this plugin must never be
imported from `web/`.* Put the same sentence at the top of `core/index.ts`, where
an author lands. A doc asserting the opposite of the code is worse than the
hazard. The `AUTOGENERATED` blocks regenerate via `./equin build`.

## Verification

Each step is independently revertible; verify at each boundary.

**After step 1:**
```bash
./equin check boundary-rules            # the one that could plausibly break
./equin check plugin-boundaries no-reexport-default
./equin check plugins-registry-in-sync pre-barrel-manifests-complete
bun test plugins/infra/plugins/file-sink/core/internal/file-sink.test.ts
bun test plugins/infra/plugins/retention/server/internal/growth-bounds.test.ts
./equin build                           # regenerates AUTOGEN blocks + docs
```

**After step 2:** `bun test plugins/infra/plugins/file-sink/core/internal/`

**After step 3 — the original failure must be gone:**
```bash
./equin check type-check                # no no-adhoc-file-sink violation
bun test plugins/framework/plugins/tooling/plugins/lint/plugins/sink-safety/lint/
```
The second command is the control: it confirms the rule still fires on its
fixtures, so a green `type-check` means *fixed*, not *rule broken*. Then run
`./equin check` end-to-end (exercises the progress log for real) and
confirm run reconstruction still works via the progress reader.

A full `./equin build` here also exercises the one failure mode this change
*introduces*: `defineFileSink` throws on duplicate id, and `checks/core/index.ts`
is pulled in by the barrel-import stub loader in the same process that then runs
checks in-process. Assessed low-risk (Bun's ESM registry keys on resolved path,
and op-log + log-channels already `defineFileSink` at module scope and survive
that loader), but it is worth deliberately triggering.

**After step 4:** load Debug → Profiling ops Gantt and stats/pushes; confirm bars
still render, including interrupted markers.

**Final:** `./equin check` clean.

## Critical files

- `plugins/infra/plugins/file-sink/{core,server}/` — the move + new reader
- `plugins/framework/plugins/tooling/plugins/checks/core/progress-log.ts` — the violation
- `plugins/debug/plugins/profiling/plugins/op-log/server/internal/{jsonl,read}.ts` — the 128 MB read
- `plugins/primitives/plugins/log-channels/server/internal/persist.ts` — source of the lifted reader; `sanitizeChannel` dedup
- `plugins/infra/plugins/retention/server/internal/growth-bounds.ts` — import path only
