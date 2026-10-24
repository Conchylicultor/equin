# `mise trust` silently never runs — fix argv resolution, delete the redundant call, fix `trusted_config_paths` dedup

## Context

`setupWorktree()` (`plugins/infra/plugins/worktree/server/internal/worktree.ts:451`)
and `trustMiseConfig()` (`plugins/release/plugins/source-checkout/server/internal/source-checkout.ts:347`)
both spawn `mise trust <config>.toml` via `spawnCaptured(["mise", "trust", ...], {...})`
with the **bare, unresolved string `"mise"`** as argv[0]. `spawnCaptured` does no
PATH expansion of its own beyond what the OS/Bun gives a spawned child, and on
this machine (and generally, for any agent shell that only puts mise's *shims*
dir on PATH — `mise` itself is not mise-managed, so it has no shim) `mise` is not
on PATH; the real binary is at `~/.local/bin/mise`. So both calls are a
guaranteed `ENOENT` today, and both call sites catch that failure and treat it
as a no-op — one via a blanket `catch {}`, one via an explicit `err.code ===
"ENOENT"` branch. Confirmed harmless-but-broken by
`research/2026-09-27-global-mise-shim-self-loop.md`, which investigated an
unrelated shim self-loop incident, exonerated both call sites of causing it, and
filed this as a deferred follow-up:

> `mise trust` in `worktree.ts:451` fails silently... `trusted_config_paths`
> covers the same thing, so it is probably dead weight. Either delete it or
> route it through a shared `miseBin()` with a real error. `source-checkout.ts:347`
> has the same bare `"mise"`.

That research doc also flagged a second, related bug: the repo-root `mise.toml`'s
`[tasks.setup]` task runs `mise settings add trusted_config_paths
"$main_root/.claude/worktrees"` on every `mise install` (via the `postinstall`
hook), with a comment claiming `settings add` dedupes. It does not — verified on
this machine, `~/.config/mise/config.toml`'s `trusted_config_paths` array holds
the same path three times.

This plan fixes both: resolve the real `mise` binary at the two call sites
(deleting the one that's genuinely redundant with the machine-global trust
setting, fixing the one that isn't), and make `[tasks.setup]`'s trust
registration actually idempotent as its comment already claims.

## Approach

### 1. `worktree.ts` — delete the per-worktree `mise trust` call

The machine-global `trusted_config_paths` entry is a path *glob* on
`.claude/worktrees` itself, set once at `mise install` time — it structurally
covers every worktree ever created under that path, present and future, exactly
like the `[tasks.setup]` comment describes ("covers worktrees created by the
server, by config-staging, AND by the Claude Code harness alike"). The
per-worktree call in `setupWorktree` is therefore fully redundant with it. Two
more signals confirm it's safe to delete rather than fix:

- The code's own comment already treats total absence of trust as a non-event:
  "a missing trust only costs the agent one prompt later."
- It has been silently ENOENT-failing — i.e. a complete no-op — for as long as
  this bug has existed, with no observed regression.

Per this repo's fix ladder, removing dead-weight code that shouldn't exist
outranks patching it to work correctly. Delete:

- The `try { await spawnCaptured(["mise", "trust", ...]) } catch {}` block and
  its three comment blocks, lines 443–462 of
  `plugins/infra/plugins/worktree/server/internal/worktree.ts` (inside
  `setupWorktree`, after the `withWorktreeMutateSlot` call and before the
  function's closing brace).
- The `signal?.throwIfAborted()` re-raise immediately after it — it existed
  solely to un-swallow an abort the deleted `catch {}` would otherwise absorb.
  With the try/catch gone, there's nothing to re-raise past.
- The now-unused `const MISE_TRUST_TIMEOUT_MS = 30_000;` (line 46) — confirmed
  no other reference in the file.
- The stale clause in the comment above `withWorktreeMutateSlot` (lines 422–424:
  "The idempotent existsSync early-return and `mise trust` stay outside the
  gate...") — drop the `mise trust` mention.
- The `mise trust`-specific paragraph in
  `plugins/infra/plugins/worktree/CLAUDE.md`'s "Cancellation" section (the one
  documenting the abort-re-raise behavior being deleted).

Keep the `spawnCaptured` import — used by ~9 other call sites in this file.

### 2. `source-checkout.ts` — fix `trustMiseConfig` to resolve the real binary

This call is **not** redundant: its own docblock already says why —
"The machine-global `trusted_config_paths` covers only `.claude/worktrees`" —
and release checkouts live under `cache/release-checkouts/`, outside that glob.
This is the only thing that would ever trust a release checkout's `mise.toml`,
so it must be fixed, not deleted.

Replace the errno-sniffing catch with an explicit pre-check using the new
`findMiseBin()` (below) — a checked fact instead of one inferred from a spawn
failure's `code`:

```ts
async function trustMiseConfig(root: string): Promise<void> {
  const bin = findMiseBin();
  if (bin === null) return; // mise genuinely not installed: legitimate no-op
  const r = await spawnCaptured([bin, "trust", join(root, "mise.toml")], {
    timeoutMs: MISE_TRUST_TIMEOUT_MS,
  });
  if (r.timedOut || r.exitCode !== 0) {
    console.warn(
      `  mise trust ${root}/mise.toml did not succeed ` +
        `(${r.timedOut ? "timed out" : `exit ${r.exitCode}`}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}
```

Add `import { findMiseBin } from "@plugins/toolchain/core";`. Update the
docblock's "mise may not be on this process's PATH at all (ENOENT)" line to
reflect the new resolver ("mise may not be installed at all —
`findMiseBin` returns `null`"). Keep the existing "best-effort... a trust that
RAN and failed is printed, never swallowed" policy — that's exactly what the
new shape does; if `spawnCaptured` itself throws after a successful resolve
(binary vanished between resolution and spawn), it now propagates unguarded,
which is correct: that's no longer "mise absent," it's a genuine anomaly.
`MISE_TRUST_TIMEOUT_MS` (this file's own copy, `= 30_000`) stays as-is.

Confirmed no existing import edge in either direction between `toolchain` and
`release`, so this creates no cycle.

### 3. Promote a non-throwing binary resolver into `plugins/toolchain/core`

`plugins/toolchain/shared/mise.ts` already has the correct PATH-then-fallback
resolution logic in its private `miseBin()`, but `shared/` is plugin-private
(cross-plugin imports from `shared/` are forbidden — R10, enforced by
`./equin check plugin-boundaries`), so neither `infra/worktree` nor
`release/source-checkout` can reach it as-is.

Promote it into `toolchain/core` (the plugin's public, cross-plugin-importable
barrel) rather than `infra/spawn`: `toolchain` already owns all mise-domain
knowledge in this repo (`TOOLS`, `HOLDS`, lock parsing, version comparison), so
this is a policy change (export what already exists) rather than new design.
`infra/spawn` owns the spawn *primitive*, not tool-specific resolution — it
already has `getWorktreeRoot`/`getMainRepoRoot`, but those are a generic
repo-structure concern every plugin needs; inventing a generic
`resolveBinary(name, fallbackPaths)` there for mise's one caller pattern would
be speculative (no second consumer exists). `toolchain/core` also already
exports non-upgrade-specific mise facts (`parseMiseLock`,
`parseMiseToolRequests`), so a binary-resolution export fits its existing
surface. Node-only code living in a plugin's `core/` is precedented — e.g.
`infra/spawn/core` and `framework/tooling/format/core` both do this behind a
"RUNTIME-NEUTRAL NODE, not web-safe" banner comment, which this new file should
copy (nothing calls the new functions from web, but the convention documents
the constraint for the next reader).

New file `plugins/toolchain/core/internal/mise-bin.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";

/**
 * Locates the `mise` binary: PATH first, then its installer's default
 * location — an agent shell often has mise's shims on PATH but not mise
 * itself. Returns `null` (never throws) so a best-effort caller — mise
 * genuinely not installed is a legitimate no-op for them — doesn't need to
 * catch an error to find that out.
 */
export function findMiseBin(): string | null {
  const onPath = Bun.which("mise");
  if (onPath !== null) return onPath;
  const installed = join(HOME_DIR, ".local", "bin", "mise");
  return existsSync(installed) ? installed : null;
}

/** Same resolution, but throws for a caller that requires mise to proceed. */
export function miseBin(): string {
  const bin = findMiseBin();
  if (bin !== null) return bin;
  throw new Error(
    `mise is not installed (not on PATH, not at ${join(HOME_DIR, ".local", "bin", "mise")}). Install it: https://mise.jdx.dev`,
  );
}
```

Add to `plugins/toolchain/core/index.ts`:

```ts
export { findMiseBin, miseBin } from "./internal/mise-bin";
```

Then collapse the duplicate in `plugins/toolchain/shared/mise.ts`: delete its
local `miseBin()` (lines 10–18) and the imports that become unused
(`existsSync` from `"fs"`, `HOME_DIR`, and `join` if nothing else in the file
uses it — `dirname` is still needed for `MISE_CEILING_PATHS`), and import
`miseBin` from `@plugins/toolchain/core` instead. This is a same-plugin
`shared → core` edge, explicitly legal per the boundary table.

This satisfies the boundary rules directly: `source-checkout.ts` imports
`findMiseBin` straight from `@plugins/toolchain/core` (no cross-plugin
re-export chain), the barrel edit is a pure re-export (barrel purity), and
there's no cycle.

### 4. Fix `trusted_config_paths` non-dedup in `mise.toml`'s `[tasks.setup]`

Verified: `mise settings` has `get`/`set`/`add`/`unset` but no dedupe-on-add.
`set` would overwrite the whole array, which is unsafe — something else may
have trusted unrelated paths there too, and a blind overwrite would silently
untrust them. Fix is read-then-conditionally-add, replacing lines 46/50 of the
repo-root `mise.toml`:

```bash
# Trust every current & future worktree's mise.toml in one shot. Each `git
# worktree add` inherits this committed config at a fresh, untrusted path, so
# shim invocations (bun/go/tmux) inside .claude/worktrees/<wt> otherwise emit
# "config not trusted" errors — including from Claude Code's PreToolUse Bash
# hook. Registering the directory is path-glob based, so it covers worktrees
# created by the server, by config-staging, AND by the Claude Code harness
# alike. `settings add` does NOT dedupe (verified: a repeated setup run
# appends a duplicate) — guarded below by checking first.
# Derive the MAIN checkout from git (worktrees live at <main>/.claude/worktrees)
# so this is correct whether setup runs from the main clone or from a worktree.
main_root="$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)"
trusted_wt_path="$main_root/.claude/worktrees"
if ! mise settings get trusted_config_paths --json 2>/dev/null | grep -qF "\"$trusted_wt_path\""; then
  mise settings add trusted_config_paths "$trusted_wt_path"
fi
```

Land this as its own commit (mechanically unrelated — shell task idempotency
vs. TypeScript argv resolution) even though it ships in the same change: same
investigation, same research doc, and leaving a comment now known to be false
sitting next to a change that just fixed two other silent mise no-ops would be
an inconsistent outcome to leave behind.

## Verification

1. `./equin check plugin-boundaries` and `./equin check
   boundary-rules` — confirms the new `toolchain/core` export and the
   `source-checkout.ts` → `toolchain/core` import are legal.
2. `./equin check type-check` — confirms no dangling imports after
   deleting `worktree.ts`'s block and `shared/mise.ts`'s duplicate `miseBin`.
3. `./equin check plugins-doc-in-sync` will fail until `./equin
   build` regenerates `docs/plugins-details.md`, `docs/plugins-compact.md`, and
   `plugins/toolchain/CLAUDE.md`'s autogen reference block (the `core` export
   list changes) — run the build, don't hand-edit those three files.
4. `./equin build` — deploys the worktree; confirms the whole app still
   boots (this touches boot-path-adjacent worktree/release code, so a broken
   import would surface immediately).
5. Manually exercise the fixed path: from a fresh test directory, confirm
   `Bun.which("mise")` really is `null` in this shell's PATH (or simulate it by
   temporarily unsetting PATH's mise-shims entry) and that `findMiseBin()`
   still resolves `~/.local/bin/mise`. Then create a throwaway worktree (or
   trigger `acquireReleaseCheckout` via a release run) and confirm — via
   `mise trust --show` or by running a shimmed command like `bun --version`
   inside the release checkout — that `cache/release-checkouts/<run>/mise.toml`
   is now actually trusted (previously this always silently no-op'd).
6. For the dedup fix: run `mise run setup` twice in a row and confirm
   `mise settings get trusted_config_paths --json` shows the worktrees path
   exactly once, not accumulating duplicates.
