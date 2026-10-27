import { realpathSync } from "node:fs";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import {
  frameKey,
  type StackFrame,
  type ThreadActivity,
} from "@plugins/infra/plugins/stack-sampler/core";

/**
 * Who a stack sample's slice of thread time belongs to.
 *
 * Five kinds, because a JSC sample can only tell us so much. The probes (Bun
 * 1.3.13) found three stack shapes, and each needs its own rule:
 *
 * - sync code a check runs itself keeps the check's frame on the stack
 *   (`spin ← checkRun`) — `check`;
 * - a shared async helper resumed after an `await` has LOST its caller
 *   (`spin ← helper`, no `checkRun`) — `shared`, named by the helper;
 * - module evaluation from `await import()` has no importer at all
 *   (`(module) ← evaluate ← moduleEvaluation ← requestImportModule`) — `import`.
 *
 * Anything with no source frame at all is `native` — unless a
 * `withThreadActivity` interval was running when it was taken, in which case it
 * is `activity`, named by that activity (the barrel-import lane marks each
 * import, whose load and evaluation otherwise sample as a bare
 * `(anonymous) [Unknown Executable]`). A `shared` owner does not say which check
 * called it; the stall record's `running` list is that link.
 */
export type ThreadOwner =
  | { kind: "check"; module: string }
  /**
   * `plugin` is the evaluated module's plugin, kept as a DETAIL rather than as
   * part of the owner. ~800 barrels would otherwise each own a sliver, and a
   * large import chain — the suspect this exists to catch — would look like
   * nothing at all.
   */
  | { kind: "import"; plugin: string | null }
  | { kind: "shared"; site: string }
  /**
   * A native-only sample taken during an activity. `detail` (the barrel path)
   * is kept out of the owner for the same reason an `import`'s plugin is.
   * "during", not "caused by": the interval also covers whatever else ran while
   * the marked work awaited.
   */
  | { kind: "activity"; name: string; detail: string }
  | { kind: "native"; leaf: string };

/**
 * The roots a frame path is made relative to: `root` and its realpath.
 *
 * Both, because JSC hands back FULLY RESOLVED paths (`/private/tmp/…` for a
 * checkout at `/tmp/…`). Stripping the plain root alone would turn every frame
 * of a checkout reached through a symlink into "outside the repo" — no check
 * would ever own a sample, and nothing would say so.
 */
export function repoRoots(root: string = REPO_ROOT): string[] {
  const real = realpathSync(root);
  return real === root ? [root] : [root, real];
}

/** `path` relative to the first root that prefixes it, or null when none does. */
function relativize(path: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  }
  return null;
}

/**
 * The npm package a path sits in (`pg`, `@scope/name`), or null. Taken after the
 * LAST `node_modules/`, so bun's nested `.bun/<pkg>@<v>/node_modules/<pkg>`
 * layout still names the package rather than the store.
 */
function packageOf(path: string): string | null {
  const at = path.lastIndexOf("/node_modules/");
  if (at === -1) return null;
  const [first, second] = path.slice(at + "/node_modules/".length).split("/");
  if (!first) return null;
  return first.startsWith("@") && second ? `${first}/${second}` : first;
}

/**
 * A check module's frame: a file under a `check/` directory that sits DIRECTLY
 * under a plugin directory. No registry is needed — `./equin check`
 * discovers checks from exactly this folder name, and the runner's own files
 * live under `checks/core/`, so they never match.
 *
 * Spelled segment by segment rather than `^plugins/(.+)/check/`: the looser
 * form also matches a plugin NAMED `check` —
 * `plugins/framework/plugins/cli/plugins/check/cli/run.ts`, the command that
 * calls the runner, would have owned the run's own sync prologue.
 */
const CHECK_MODULE = /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/check\//;

/** The plugin a repo-relative path belongs to (`database/plugins/migrations/…` → its dir). */
const PLUGIN_PATH = /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\//;

/** `database/plugins/migrations` → `database/migrations`: the id the docs use. */
function collapsePluginPath(path: string): string {
  return path.split("/plugins/").join("/");
}

/** A frame the runtime attributes to a source file, i.e. not a native frame. */
function sourceOf(frame: StackFrame): string | null {
  return frame.sourceURL !== null && frame.sourceURL !== ""
    ? frame.sourceURL
    : null;
}

function nameOf(frame: StackFrame): string {
  return frame.name !== "" ? frame.name : "(anonymous)";
}

/**
 * The frames that mean "a module's top level is being evaluated". The two named
 * native frames are what an `await import()` puts under the evaluated module;
 * `(module)` is the module body itself, which is all a top-level-await
 * continuation leaves on the stack.
 */
const MODULE_EVALUATION = new Set([
  "requestImportModule",
  "moduleEvaluation",
  "(module)",
]);

/**
 * Render a source path for a frame key: repo-relative when it is in the repo,
 * `node_modules/<rest>` when it is a dependency, verbatim otherwise.
 */
export function shortenSource(
  sourceURL: string,
  roots: readonly string[],
): string {
  const rel = relativize(sourceURL, roots);
  if (rel !== null) return rel;
  const at = sourceURL.lastIndexOf("/node_modules/");
  return at === -1 ? sourceURL : sourceURL.slice(at + 1);
}

/** The detail an `import` sample keeps: the evaluated module's plugin or package. */
function moduleOwnerOf(path: string, roots: readonly string[]): string {
  const pkg = packageOf(path);
  if (pkg !== null) return pkg;
  const rel = relativize(path, roots);
  if (rel === null) return path;
  const plugin = PLUGIN_PATH.exec(rel);
  return plugin?.[1] ? collapsePluginPath(plugin[1]) : rel;
}

/**
 * Attribute one sample. PURE: the only inputs besides the frames are `roots`,
 * which `repoRoots()` computes once per run, and the sample's own `activity`. Rules, in order:
 *
 * 1. **A frame from a check module** (anywhere on the stack, innermost first)
 *    → `check`. Beneath a runner frame or a shared helper it still wins: sync
 *    work a check started is that check's.
 * 2. **Module evaluation** → `import`, keeping the evaluated module's plugin as
 *    the detail.
 * 3. **The outermost frame with a source file** → `shared`, named by it. That is
 *    the async function that resumed, and it owns this slice. A frame IN THE
 *    REPO is preferred over a dependency's: when a library dispatches a repo
 *    callback (commander calling an action, an emitter calling a listener) the
 *    library is outermost but the callback is the work. With no repo frame, a
 *    `node_modules` frame collapses to its package name.
 * 4. **Native frames only** → `activity` when the sample was taken during one
 *    (`activity`, stamped by the sampler at sample time), else `native`, named
 *    by the leaf. Only here: a frame that names its owner always wins over an
 *    activity, which says when, not who.
 *
 * One more frame the stack can lose (measured on Bun 1.3.13): JSC
 * implements PROPER TAIL CALLS, and ES modules are strict, so a SYNC function
 * whose last act is `return heavy()` is gone from the stack while `heavy` runs.
 * A sync check body written that way hands its samples to the next frame out
 * (the runner, or whatever called it). An `async` function's `return heavy()` is
 * not a tail call, so a check's `async run()` keeps its frame; only a sync
 * wrapper returning straight into the heavy call loses it.
 */
export function ownerOf(
  frames: readonly StackFrame[],
  roots: readonly string[],
  activity: ThreadActivity | null = null,
): ThreadOwner {
  for (const frame of frames) {
    const source = sourceOf(frame);
    // A dependency's own `check/` directory is not one of ours.
    if (source === null || packageOf(source) !== null) continue;
    const rel = relativize(source, roots);
    const check = rel === null ? null : CHECK_MODULE.exec(rel);
    if (check?.[1]) {
      return { kind: "check", module: collapsePluginPath(check[1]) };
    }
  }

  if (frames.some((frame) => MODULE_EVALUATION.has(frame.name))) {
    const evaluated =
      frames.find(
        (frame) => frame.name === "(module)" && sourceOf(frame) !== null,
      ) ?? frames.find((frame) => sourceOf(frame) !== null);
    const source = evaluated ? sourceOf(evaluated) : null;
    return {
      kind: "import",
      plugin: source === null ? null : moduleOwnerOf(source, roots),
    };
  }

  let outermostRepo: { frame: StackFrame; rel: string } | null = null;
  let outermostSource: StackFrame | null = null;
  for (const frame of frames) {
    const source = sourceOf(frame);
    if (source === null) continue;
    outermostSource = frame;
    const rel = packageOf(source) === null ? relativize(source, roots) : null;
    if (rel !== null) outermostRepo = { frame, rel };
  }
  if (outermostRepo !== null) {
    return {
      kind: "shared",
      site: `${nameOf(outermostRepo.frame)} @ ${outermostRepo.rel}`,
    };
  }
  if (outermostSource !== null) {
    const source = sourceOf(outermostSource) ?? "";
    return {
      kind: "shared",
      site: packageOf(source) ?? `${nameOf(outermostSource)} @ ${source}`,
    };
  }

  if (activity !== null) {
    return { kind: "activity", name: activity.name, detail: activity.detail };
  }
  const leaf = frames[0];
  return { kind: "native", leaf: leaf ? frameKey(leaf) : "(no frames)" };
}

/**
 * An owner's label, which is also its identity in every tally. An `import`
 * owner's plugin is deliberately NOT part of it — see `ThreadOwner`.
 */
export function ownerLabel(owner: ThreadOwner): string {
  switch (owner.kind) {
    case "check":
      return `check ${owner.module}`;
    case "import":
      return "import";
    case "shared":
      return `shared ${owner.site}`;
    case "activity":
      return `native during ${owner.name}`;
    case "native":
      return `native ${owner.leaf}`;
  }
}

/** One owner's share of a set of samples. */
export interface OwnerShare {
  owner: string;
  samples: number;
  /**
   * ONE representative sample's stack, innermost first, as frame keys — the
   * first sample seen for this owner. `frame.line` is the EXECUTING line, so
   * read it as "a" position on the owner's path, not "the" position.
   */
  example: string[];
  /**
   * What an owner that pools many sources was made of (an `import` owner's
   * evaluated plugins, an `activity` owner's instances), busiest first. Empty
   * for every other owner.
   */
  detail: { name: string; samples: number }[];
}

/** How many frames an example keeps — the transcript's depth; records cut it further. */
export const EXAMPLE_FRAMES = 8;

/** How many entries an owner's `detail` keeps. */
const DETAIL_ENTRIES = 3;

/** A running per-owner sample count. */
export interface OwnerTally {
  readonly samples: number;
  add(owner: ThreadOwner, frames: readonly StackFrame[]): void;
  /** The `n` busiest owners, busiest first. */
  top(n: number): OwnerShare[];
}

/**
 * Count samples per owner. The owner is computed by the CALLER and handed in,
 * so one sample can land in several tallies (the whole run, one stall, all
 * stalls) for one attribution.
 */
export function createOwnerTally(roots: readonly string[]): OwnerTally {
  const buckets = new Map<
    string,
    { samples: number; example: string[]; detail: Map<string, number> }
  >();
  let samples = 0;
  const shorten = (sourceURL: string): string =>
    shortenSource(sourceURL, roots);

  return {
    get samples() {
      return samples;
    },
    add(owner, frames) {
      samples += 1;
      const key = ownerLabel(owner);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          samples: 0,
          example: frames
            .slice(0, EXAMPLE_FRAMES)
            .map((frame) => frameKey(frame, shorten)),
          detail: new Map(),
        };
        buckets.set(key, bucket);
      }
      bucket.samples += 1;
      const detail =
        owner.kind === "import"
          ? owner.plugin
          : owner.kind === "activity"
            ? owner.detail
            : null;
      if (detail !== null) {
        bucket.detail.set(detail, (bucket.detail.get(detail) ?? 0) + 1);
      }
    },
    top(n) {
      return [...buckets.entries()]
        .sort((a, b) => b[1].samples - a[1].samples)
        .slice(0, n)
        .map(([owner, bucket]) => ({
          owner,
          samples: bucket.samples,
          example: bucket.example,
          detail: [...bucket.detail.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, DETAIL_ENTRIES)
            .map(([name, count]) => ({ name, samples: count })),
        }));
    },
  };
}

/**
 * Which of five closed buckets the thread was doing WORK in, read off a
 * sample's innermost frame alone (`frames[0]`) — cheap by construction: no
 * extra stack walk, since the watch already has the frame in hand. Where
 * `ownerOf` asks "whose code is this" (walking the whole stack for a `check`
 * frame), `classifyLeaf` asks "what was the thread physically doing" — stuck in
 * a synchronous syscall, waiting on a spawned process, loading a module, or
 * running ordinary JS. The two answer different questions about the SAME
 * sample; a stall record carries both.
 *
 * Every name below was read off real stalls
 * (`~/.equin/logs/check-progress/check-progress.jsonl`, `owners[].example`)
 * on 2026-09-15. An unrecognized name is never dropped — it falls through to
 * `cpu` (it has a source file) or `native` (it doesn't), and the stall's
 * `leaves` tally keeps its raw name visible either way.
 */
export type StallKind =
  "blocking-io" | "process" | "module-load" | "cpu" | "native";

/** Every kind, in the order a report lists them. */
export const STALL_KINDS: readonly StallKind[] = [
  "blocking-io",
  "process",
  "module-load",
  "cpu",
  "native",
];

/** The transcript's word for each kind. */
export const STALL_KIND_LABELS: Record<StallKind, string> = {
  "blocking-io": "blocking I/O",
  process: "process start",
  "module-load": "module load",
  cpu: "CPU",
  native: "native",
};

/** Bun's spawn machinery: `Bun.spawn`/`Bun.spawnSync`'s native frames, plus the
 *  rusage read right after a spawned child settles. */
const PROCESS_LEAVES = new Set([
  "spawn",
  "spawnSync",
  "posix_spawn",
  "resourceUsage",
]);

/** The module loader's own native frames — `await import()`'s machinery,
 *  CommonJS `require()`, and the loader's own fetch/parse under
 *  `requestInstantiate` (dynamic import resolving a specifier). */
const MODULE_LOAD_LEAVES = new Set([
  "require",
  "requestImportModule",
  "requestInstantiate",
  "requestFetch",
  "fetch",
  "parseModule",
  "moduleEvaluation",
  "moduleDeclarationInstantiation",
  "(module)",
]);

/**
 * A native `fooSync` frame. No per-function list is needed: every sync fs/glob
 * entry point (`readdirSync`, `existsSync`, `readFileSync`, `statSync`,
 * `lstatSync`, `realpathSync`, `openSync`, `writeFileSync`, `rmSync`,
 * `mkdirSync`, `cpSync`, `mkdtempSync`, `Bun.Glob`'s `__scanSync`, …) already
 * ends in `Sync` by Node/Bun's own naming convention, and it is a native
 * binding — no source file. Repo code essentially never names a function that
 * way, so the pattern alone is the rule.
 */
function isSyncLeaf(frame: StackFrame): boolean {
  return sourceOf(frame) === null && frame.name.endsWith("Sync");
}

/** Classify one sample by its innermost frame — see `StallKind`. */
export function classifyLeaf(frame: StackFrame): StallKind {
  if (MODULE_LOAD_LEAVES.has(frame.name)) return "module-load";
  // Checked before the `Sync` pattern: `spawnSync` would otherwise match it.
  if (PROCESS_LEAVES.has(frame.name)) return "process";
  if (isSyncLeaf(frame)) return "blocking-io";
  return sourceOf(frame) !== null ? "cpu" : "native";
}

/** How many raw leaf names a stall's `leaves` list keeps. */
export const STALL_LEAVES = 8;

/** One raw leaf's tally entry. */
export interface LeafShare {
  leaf: string;
  samples: number;
}

/** A running per-kind, per-raw-leaf sample count, over each sample's `frames[0]`. */
export interface KindTally {
  readonly samples: number;
  add(frames: readonly StackFrame[]): void;
  /** All five kinds, zero-filled — a caller never special-cases an unseen one. */
  counts(): Record<StallKind, number>;
  /** The `n` busiest raw leaf names (as `frameKey` renders them), busiest first. */
  topLeaves(n: number): LeafShare[];
}

/**
 * Count samples by `classifyLeaf(frames[0])`, plus the raw leaf names — the
 * "hot leaf" view a closed 5-kind bucket can't show on its own. `roots` shortens
 * a leaf's source the same way `createOwnerTally` does and for the same reason:
 * a frame's `sourceURL` is fully resolved, so a checkout reached through a
 * symlink needs both spellings stripped.
 */
export function createKindTally(roots: readonly string[]): KindTally {
  const counts: Record<StallKind, number> = {
    "blocking-io": 0,
    process: 0,
    "module-load": 0,
    cpu: 0,
    native: 0,
  };
  const leaves = new Map<string, number>();
  let samples = 0;
  const shorten = (sourceURL: string): string =>
    shortenSource(sourceURL, roots);

  return {
    get samples() {
      return samples;
    },
    add(frames) {
      samples += 1;
      const leaf = frames[0];
      counts[leaf ? classifyLeaf(leaf) : "native"] += 1;
      const key = leaf ? frameKey(leaf, shorten) : "(no frames)";
      leaves.set(key, (leaves.get(key) ?? 0) + 1);
    },
    counts() {
      return { ...counts };
    },
    topLeaves(n) {
      return [...leaves.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([leaf, count]) => ({ leaf, samples: count }));
    },
  };
}
