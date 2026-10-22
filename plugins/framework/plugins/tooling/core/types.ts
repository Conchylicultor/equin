import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type {
  ExemptableRuleId,
  FileCategory,
  ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";

/**
 * What every check is handed when run. `grant` is the host CPU admission the
 * invoking build/check/push already holds — a check that fans out heavy children
 * (type-check's tsc worker, layout-geometry's Chromium suite) spends
 * `grant.run(...)` per child instead of acquiring host-wide again, so the whole
 * check pass is accountable to the one grant. Checks that spawn nothing heavy
 * ignore the argument.
 */
export interface CheckContext {
  grant: Grant;
  /**
   * Emit a NON-FATAL OBSERVATION from inside a check — a measurement, a capacity
   * note, anything a passing check needs to say. The line goes wherever the
   * runner's own lines go: the console AND the durable transcript (the run's own
   * `check-<runId>.log`,
   * and the build's checks section in `build.log`), so an observation is
   * greppable after the fact instead of scrolling past in a terminal.
   *
   * It exists because a check had NO output channel of its own: `CheckResult`
   * carries a `message` only on `ok: false`, so a passing check writing to
   * `process.stderr` reached the terminal and nowhere else. Measurements that
   * must survive the run (e.g. type-check's per-worker `maxRSS`, which calibrates
   * host-admission's RAM quantum) evaporated.
   *
   * NOT an error channel, and NOT an escape hatch for silencing a failure: a
   * check that has found a violation MUST return `{ ok: false, message }` (or
   * throw). Logging a problem here instead would make it non-fatal and invisible
   * to the verdict — the exact "fail loudly" violation the repo forbids.
   *
   * OPTIONAL: a check that observes nothing ignores it; a caller that runs a
   * check outside the runner may not supply one. Call it as `ctx.log?.(…)`.
   */
  log?: (line: string, stream: "stdout" | "stderr") => void;
  /**
   * False when the run was asked to bypass caches (`--no-cache` /
   * `SINGULARITY_CHECK_NO_CACHE=1`).
   *
   * The runner honours it for its own result cache, but a check with caches of
   * its OWN has to be told — otherwise `--no-cache` stops meaning "actually do
   * the work", which is the entire reason someone types it. `type-check` reads
   * it to disarm its program skip, so a debugging run really does rebuild the
   * tsc program.
   *
   * OPTIONAL, defaulting to cached, so a caller outside the runner need not
   * think about it: read it as `ctx.cacheEnabled !== false`.
   */
  cacheEnabled?: boolean;
  /**
   * The run's file set (see `RepoFiles`). Lazy + memoized per run: the first
   * call loads it, later calls — from any check — share it.
   *
   * Check code gets the files it inspects HERE, never from its own
   * `readdirSync` walk, `Bun.Glob.scanSync`, `existsSync` probe loop or
   * `git ls-files`. Every check in a pass shares one JS thread, and a blocking
   * call per file across the tree — ~100× slower at the background priority
   * agent check passes run at — holds that thread for every other check (see
   * `checks/CLAUDE.md`).
   *
   * For an `inputKeyed` check, whatever it lists and reads through this is
   * recorded in its read-set, with no extra code.
   */
  repo(): Promise<RepoFiles>;
  /**
   * The run's tree as git hashed it: its tree hash and every blob's sha (see
   * `GitTreeSnapshot`). Lazy + memoized per run, and the SAME snapshot the
   * cache key and the input-keyed replay read when caching is on.
   *
   * Computed under `--no-cache` too: a tree hash is a fact about the checkout,
   * not a cache, so a check that keys its own work on file identity (type-check
   * versions every file by its blob sha) has one on every run. Rejects when
   * git cannot hash the tree — a check that asked has nothing to key on.
   *
   * NOT recorded in an input-keyed check's read-set: it is the raw tree. Record
   * what the verdict reads through the scan view (or `repo()`).
   */
  snapshot(): Promise<GitTreeSnapshot>;
  /**
   * The exemptions for one of THIS check's `exemptable` ids — what the
   * exempted plugins declared in their own `exempt/index.ts`. Asking for an id
   * the check did not declare throws.
   *
   * The manifests are read through `repo()`, so an input-keyed check's
   * read-set covers them and a manifest edit invalidates its cached PASS.
   *
   * After `run()` the runner FAILS the check for every exemption of its ids
   * that matched nothing: ask `skips` only for a violation you would
   * otherwise report.
   */
  exempt(id: ExemptableRuleId): Promise<CheckExemptions>;
  /** Whether the repo-relative `path` is outside every one of the check's `outOfScope` categories. */
  inScope(path: string): boolean;
}

/** A check's view of one exemptable id. */
export interface CheckExemptions {
  /**
   * Whether the check must not report a violation at the repo-relative
   * `path`: the path is in one of the check's `outOfScope` categories, or an
   * exemption covers it (recording the hit).
   */
  skips(path: string): boolean;
  /** The exemption covering `path`, recording the hit; undefined if none. Ignores `outOfScope`. */
  match(path: string): ResolvedExemption | undefined;
}

/**
 * One tree, as git hashed it: the working tree's content (tracked + untracked-
 * not-ignored, honoring .gitignore — `computeTreeHash`), with every blob's sha.
 * A read-only, in-memory projection: nothing here touches the disk.
 *
 * The checks runner's `TreeSnapshot` (checks/core) is one, with the read-set
 * projections on top.
 */
export interface GitTreeSnapshot {
  /** Absolute worktree root. */
  readonly root: string;
  /** The git tree object hash (`git write-tree` of the working tree). */
  readonly treeHash: string;
  /** Every blob path, repo-relative, in `Array.prototype.sort()` order. Frozen. */
  paths(): readonly string[];
  /** Blob sha of `path`, or null if the path is not a blob in the tree. */
  blobSha(path: string): string | null;
}

/**
 * The run's file set: every repo-relevant path — tracked + untracked-not-
 * ignored, exactly the universe the check cache key (`computeTreeHash`) and
 * `listRepoFiles` cover. Loaded once per run and shared by every check.
 *
 * Build one with `loadRepoFiles(root)`; inside a check, the run's is
 * `ctx.repo()`.
 *
 * Every path argument is spelled the way the set spells its members:
 * repo-relative, `/`-separated, no leading `/` or `./`, no trailing `/`, no `.`
 * or `..` segment. Any other spelling THROWS — it would match nothing and read
 * as "not in the set", so `under("plugins/")` would hand a check an empty repo.
 */
export interface RepoFiles {
  /** Absolute worktree root. */
  readonly root: string;
  /**
   * Every file path, repo-relative, sorted (`Array.prototype.sort()` order).
   * For an input-keyed check this records a whole-tree membership fact —
   * prefer `under`.
   */
  all(): readonly string[];
  /** True iff `path` (repo-relative, no leading "./") is a file in the set. */
  has(path: string): boolean;
  /**
   * Every file under directory `dir` (repo-relative, no trailing slash; "" =
   * whole repo), recursive, sorted. In-memory: two binary searches.
   */
  under(dir: string): readonly string[];
  /**
   * Every file matching git pathspec `pattern`, sorted — read SUPERSET-SAFE
   * (`*` spans `/`; see `pathspecToRegex`), so a caller wanting an exact set
   * filters the answer. For an input-keyed check this records the match set
   * alone: a file added elsewhere keeps the PASS, where `under` / `all` would
   * not.
   */
  glob(pattern: string): readonly string[];
  /**
   * The working-tree content of `path` as UTF-8 text, read asynchronously
   * (bounded concurrency), or null if the file is not in the set / vanished.
   * For an input-keyed check the read is recorded in its read-set.
   *
   * The bound is ONE gate for the whole run, so handing this thousands of
   * paths at once (`Promise.all`) is fine: only a few dozen are open at a time.
   */
  read(path: string): Promise<string | null>;
}

/**
 * The scope axis, as values — so a caller that must validate one at runtime (the
 * CLI's `--scope` flag) reads the same closed set the type is derived from, and
 * a new scope can never be accepted by the type but rejected by the flag.
 */
export const CHECK_SCOPES = ["tree", "deploy", "host"] as const;

/**
 * What a check's verdict is a function of — the axis that decides which callers
 * can meaningfully assert it. See `Check.scope`.
 */
export type CheckScope = (typeof CHECK_SCOPES)[number];

export interface Check {
  id: string;
  description: string;
  run(ctx: CheckContext): Promise<CheckResult>;
  /**
   * The ids a plugin may name in its `exempt/index.ts` to let its own files
   * violate this check, each with what violating it means. An id is the
   * check's own id or `<check id>:<sub>` (one per distinct thing the check
   * forbids). Only declared ids enter `ExemptableRuleId`, so a check that
   * declares none admits no exemption by construction.
   *
   * The check reads them with `ctx.exempt(id)`; the runner fails it for any
   * exemption of these ids that matched nothing.
   */
  exemptable?: Record<string, string>;
  /**
   * File categories this check does not apply to — its scope, not an
   * exemption. Read through `ctx.inScope(path)`, or `ctx.exempt(id).skips(path)`
   * which folds it in.
   */
  outOfScope?: readonly FileCategory[];
  /**
   * What the verdict is ABOUT, which decides who can assert it:
   *   - "tree" (default) → the verdict is a function of the working-tree content
   *     hash (`computeTreeHash`: tracked files + working changes, honoring
   *     .gitignore). Whatever that hash covers is exactly what a push carries,
   *     so the check is in the push payload and every caller can assert it.
   *   - "deploy" → the check verifies the local deployment that
   *     `./singularity build` produces (`~/.singularity/worktrees/<name>/web`,
   *     the `~/.singularity/cache/web-artifacts` store). That artifact NEVER lands on
   *     main, and `push`'s own internal rebase invalidates it by construction
   *     (the tree moves past the deployed dist), so push cannot meaningfully
   *     assert it — no matter how it is scheduled. Its real homes are `build`
   *     (which deploys, then verifies), a standalone `./singularity check`, and
   *     main's post-push auto-build.
   *   - "host" → the verdict is about this MACHINE: the shared data root
   *     (`~/.singularity/`), host-global services, state no checkout owns. It is
   *     a function of neither the tree nor the artifact a build produces, and —
   *     unlike the two above — NO per-worktree caller can assert it. The subject
   *     is shared with every other checkout on the box and is AHEAD of any one
   *     branch: a worktree observing it sees state some other live branch
   *     created, which it did not cause and cannot repair. Asserting it from a
   *     build is what made `paths:no-undeclared-data-dirs` fail a deploy on a
   *     directory another agent's unmerged branch had just declared (see
   *     research/2026-09-01-global-host-scoped-data-root-audit.md). Its home is a
   *     standalone `./singularity check` and any host-singleton runner.
   *
   * TREE PURITY — the second half of what `"tree"` promises. The verdict must be
   * a function of the tree hash AND of NOTHING ELSE, including what else already
   * ran in this process. That is what makes a recorded PASS TRANSFERABLE: the
   * runner writes a cache entry from one process and a later `./singularity push`
   * reads it from another, so a verdict that also depended on process history is
   * one the reading process cannot reproduce — and has no way to detect that it
   * cannot. It just returns the green.
   *
   * How that goes wrong, from `plugins-doc-in-sync`: `reorder`'s `contributions`
   * array starts EMPTY and is filled by a `subscribeSlotsDeclared` callback, one
   * entry per reorderable slot. So the check read the full set inside a build
   * (which runs the declaration pass during codegen) and none in a standalone
   * check — one source, two outputs, decided by process history. Four builds each
   * recorded a passing entry; four pushes trusted it; a `docs/plugins-details.md`
   * that only a build could reproduce shipped across four commits.
   *
   * Commit `18126884a` is the fix shape to copy — BOTH halves, neither optional:
   *   - MOVE THE PRECONDITION INTO THE PRODUCER. `buildEnrichedTree`
   *     (`../plugins/codegen/core/enriched-tree.ts`) runs the declaration pass
   *     itself, memoized per root, so every caller gets it. It used to live in one
   *     caller's pipeline ordering, where it held for that pipeline and nowhere
   *     else.
   *   - LEAVE THE EARLY READ NO SPELLING. The contributions facet
   *     (`plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`)
   *     is handed the imported barrels and the naming the declaration pass over
   *     them settled as ONE value (`ExtractContext.imported`), so "barrels
   *     without a pass" cannot be constructed. This started as a runtime count
   *     the facet refused to extract while zero; pairing the two moved it from
   *     an assert to a type. Without either, the mistake yields a smaller answer
   *     indistinguishable from a correct one, which is exactly how it shipped.
   *
   * Consumers select BY THIS PROPERTY, NEVER by check id: `push` asks for
   * `--scope tree`, and `build` for `--scope tree,deploy` — never for
   * "everything except web-artifacts:map-in-sync". Classifying a new check is
   * then the only edit a new check needs.
   *
   * THE INVARIANT that makes this load-bearing: any scope OTHER than `"tree"`
   * means the tree hash does NOT cover the check's subject, so the check MUST
   * supply a `cacheSignature()` (covering that subject, or returning null).
   * Without one, a verdict about the deploy or the host would be recorded under
   * a tree-only cache key — a pass that survives every later change to it, i.e.
   * a permanently stale green. Enforced at load; a violation throws. Stated
   * against the `"tree"` case on purpose: written as a list of the scopes that
   * need it, a scope added later would silently owe nothing.
   */
  scope?: CheckScope;
  /**
   * Run even when `./singularity build --skip-checks` is passed (and, as always,
   * during a normal build and `push`). For cheap, structural, codegen-coupled
   * invariants whose violation is painful to discover only at push — e.g. a
   * newly-reorderable slot that still owes an authored override. Default false:
   * the check only runs in the full check pass.
   */
  alwaysRun?: boolean;
  /**
   * Cache-signature contribution. Combined with the working-tree content hash
   * to key a recorded PASS, so an unchanged tree can reuse a prior green run
   * (e.g. `push` reusing `build`'s checks):
   *   - absent  → cacheable, keyed on the tree hash alone (default for checks
   *               that are pure deterministic functions of tree content).
   *   - string  → cacheable; the string is folded into the key (use this when
   *               the result depends on a runtime parameter — e.g. eslint's
   *               scope env — so distinct parameterizations get distinct keys).
   *   - null    → NEVER cache (impure: reads DB/network/env/git history).
   * Must be cheap and side-effect-free. It may return a promise, for a
   * signature that needs git or another async read: never make a blocking
   * (`*Sync`) call here instead — it runs on the thread every check shares.
   * The runner awaits it after the check's start turn; a throw or a rejection
   * degrades to uncached, never to a failed run.
   *
   * A SIGNATURE KEYS A VERDICT; IT CANNOT MAKE ONE REPRODUCIBLE. Folding a value
   * into the key only separates two runs that would otherwise share a slot. If
   * the verdict depends on anything outside the checkout AND outside the
   * signature — including what else ran in this process (see the tree-purity note
   * on `scope`) — the correct value here is `null`, and the real repair is to
   * remove the dependency at its source rather than key around it.
   */
  cacheSignature?(): string | null | Promise<string | null>;
  /**
   * Cache-invalidation strategy — how a recorded PASS is decided still valid on
   * the next run:
   *   - absent (default) → LEGACY whole-tree keying. The PASS is keyed on the
   *     entire working-tree hash (`computeTreeHash`), so ANY tree change re-runs
   *     the check. Unchanged, always-sound, and the behaviour of every check
   *     that does not set this flag.
   *   - `true` → INPUT-KEYED via validate-by-replay. The check runs against a
   *     recording `FileSystemView` (see `checks/core/read-set.ts`) that logs the
   *     exact tree facts its verdict depended on (file contents, existence,
   *     directory membership, glob/pathspec expansion, grep selection). On the
   *     next run those facts are replayed against the fresh snapshot; a PASS
   *     survives a tree change that cannot affect the verdict. A check may set
   *     this ONLY once its ENTIRE transitive read surface routes through the
   *     view — otherwise a read via an un-instrumented path is unrecorded and a
   *     stale PASS becomes possible. Any snapshot/view/validation doubt is
   *     treated as a MISS (run), so the cache can never CAUSE a stale PASS.
   *   - `"declared"` → INPUT-KEYED via an explicit `declaredInputs()` spec rather
   *     than record-then-replay, for OPAQUE checks whose reads happen inside a
   *     subprocess the view cannot observe (e.g. `migrations-in-sync` spawning
   *     `drizzle-kit`). Wired in a later stage.
   *
   * Consumers (the runner) read this GENERICALLY and never name check ids
   * (collection-consumer rule). This flag is LIVE and runs on every check pass:
   * `type-check`, `plugin-boundaries`, `active-data`, `no-raw-event-source`,
   * `no-raw-sse`, `no-raw-websocket`, `no-hardcoded-colors`,
   * `no-hand-built-link-to` and `no-use-resource-cast` all set it today.
   *
   * THE EXTRA RULE THIS FLAG CARRIES — read it before adding the tenth adopter.
   * The read-set slot is keyed on `(checkId, cacheSignature())` with NO TREE HASH
   * AT ALL (`checks/core/cache.ts` `readSetFile`), so a PASS recorded there
   * survives forward into LATER trees for as long as the replay still validates.
   * A wrong answer on the tree-hash slot is confined to the one tree it was
   * recorded against; here there is no tree hash to bound it. A check that is not
   * a pure function of the checkout must NEVER be moved onto this flag — fix the
   * impurity at its source first. `format-clean`, `lint-directives-stable` and
   * `test-layout:runner-split` each document, at their own definition, why they
   * stay off it.
   */
  inputKeyed?: boolean | "declared";
  /**
   * For `inputKeyed: "declared"` checks only: the explicit input spec (globs +
   * files, incl. tool-version inputs like `bun.lock`) whose contents/membership
   * key the PASS, since a record-then-replay view cannot observe the check's
   * opaque subprocess reads. Optional and NOT yet consumed — reserved for the
   * declared-inputs stage.
   */
  declaredInputs?(): { globs?: string[]; files?: string[] };
}

export type CheckResult =
  | { ok: true }
  /**
   * A non-passing result. `inconclusive: true` means the check could NOT
   * determine pass/fail for an *environmental* reason (a host-load timeout, an
   * unlaunchable browser, etc.) rather than a real regression. It is treated as
   * NON-FATAL by the runner (does not block the build) and is NEVER cached (it
   * stays `ok: false`, and the runner records only `ok === true`), so the check
   * re-runs next time and re-verifies the real invariant. Omit the flag for an
   * ordinary hard failure, which stays fatal exactly as before.
   */
  | { ok: false; message: string; hint?: string; inconclusive?: true };
