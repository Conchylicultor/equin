import { join } from "path";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import {
  findImports,
  lineAt,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  getWorktreeRoot,
  spawnCaptured,
  type SpawnResult,
} from "@plugins/infra/plugins/spawn/core";
import { InconclusiveCheckError } from "@plugins/framework/plugins/tooling/core";
import { currentScanTree, currentScanView } from "./scan-context";

// Both spawns below SCAN — `git grep` walks the tree, `git cat-file --batch`
// streams back one blob per candidate — so unlike a `ls-files` metadata read
// they do work proportional to the repo. Two minutes is still two orders of
// magnitude above what either takes; it exists to break a wedge, not to police
// a slow scan.
const GIT_SCAN_TIMEOUT_MS = 120_000;

/**
 * A git scan that did not complete — a pattern git rejected, a bad pathspec or
 * tree-ish, a truncated `cat-file` stream (a timeout is
 * {@link GitScanTimeoutError}). Thrown, never absorbed:
 * the scans below feed PASS/FAIL verdicts, and a scan that never ran reads
 * exactly like one that found nothing. A throw from a check body fails that
 * check (fatal, uncached — see `thrown-outcome.ts`); from the cache replay hook
 * it degrades to a MISS, which re-runs the body and fails it the same way.
 */
export class GitScanError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: Pick<SpawnResult, "exitCode" | "stderr">,
    detail?: string,
  ) {
    const why = `exit ${result.exitCode}`;
    const stderr = result.stderr.trim();
    super(
      [
        `\`${argv.join(" ")}\` failed (${why})${detail ? `: ${detail}` : ""}`,
        ...(stderr ? [stderr] : []),
      ].join("\n"),
    );
    this.name = "GitScanError";
  }
}

/**
 * A git scan that ran out of {@link GIT_SCAN_TIMEOUT_MS}: the host was too
 * loaded to answer (a `cat-file --batch` of a few hundred blobs normally takes
 * well under a second), which says nothing about the code scanned. Still never
 * absorbed — no verdict is built on it — but the check it escapes from settles
 * as inconclusive, not as a fatal "check bug" (see `thrown-outcome.ts`).
 */
export class GitScanTimeoutError extends InconclusiveCheckError {
  constructor(readonly argv: readonly string[]) {
    super(
      `\`${argv.join(" ")}\` timed out after ${GIT_SCAN_TIMEOUT_MS / 1000}s`,
      "Host load, not a verdict: the check re-runs on the next build.",
    );
    this.name = "GitScanTimeoutError";
  }
}

export interface CodeMatch {
  /** File path relative to `root` (as reported by `git grep`). */
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** The ORIGINAL (unmasked) line text, trailing-trimmed. */
  text: string;
}

interface GrepCodeOptions {
  root: string;
  /** Source of truth: run in JS (global) on masked text to find real-code matches. */
  pattern: RegExp;
  /** Narrows candidate files via `git grep -l` (fast pre-filter). */
  grepArg: string;
  /** Pass `-F` (fixed-string) instead of `-E` (extended regexp) to git grep. */
  fixed?: boolean;
  /** Also mask string interiors (default true). */
  maskStrings?: boolean;
  /** Pathspecs scoping the git grep (default ["*.ts", "*.tsx"]). */
  pathspecs?: string[];
}

/**
 * Find real-code matches of `pattern` across the repo, ignoring occurrences that
 * live in comments, strings or regex literals.
 *
 * `git grep -l` narrows the candidate file set fast; each candidate is then read,
 * masked via `maskSource`, and re-scanned with `pattern` so only genuine code
 * matches survive — with accurate line numbers and original line text.
 */
export async function grepCode(opts: GrepCodeOptions): Promise<CodeMatch[]> {
  const pathspecs = opts.pathspecs ?? ["*.ts", "*.tsx"];
  const maskStrings = opts.maskStrings ?? true;

  const candidates = await readCandidates(
    opts.root,
    opts.grepArg,
    opts.fixed ?? false,
    pathspecs,
  );

  // Ensure the global flag so the line scan iterates all matches; build a fresh
  // matcher per file so lastIndex never leaks across files.
  const flags = opts.pattern.flags.includes("g")
    ? opts.pattern.flags
    : opts.pattern.flags + "g";

  // Each candidate is a synchronous mask + re-scan; over a wide candidate set
  // that is seconds of work on the check runner's one shared thread, so yield a
  // macrotask every few milliseconds of it.
  const slice = createTimeSlicer();
  const matches: CodeMatch[] = [];
  for (const { rel, src } of candidates) {
    await slice();
    const masked = maskSource(src, { strings: maskStrings });
    const maskedLines = masked.split("\n");
    const origLines = src.split("\n");
    const re = new RegExp(opts.pattern.source, flags);
    for (let l = 0; l < maskedLines.length; l++) {
      re.lastIndex = 0;
      if (re.test(maskedLines[l]!)) {
        matches.push({
          path: rel,
          line: l + 1,
          text: (origLines[l] ?? "").replace(/\s+$/, ""),
        });
      }
    }
  }
  return matches;
}

export interface ImportMatch {
  /** File path relative to `root` (as reported by `git grep`). */
  path: string;
  /** 1-based line number of the import statement. */
  line: number;
  /** The module specifier (between the quotes), read from the ORIGINAL source. */
  specifier: string;
  /** The ORIGINAL (unmasked) line text containing the import, trailing-trimmed. */
  text: string;
}

interface GrepImportsOptions {
  root: string;
  /** Narrows candidate files via `git grep -l` (fast pre-filter). */
  grepArg: string;
  /** Keep only imports whose specifier passes this predicate. */
  filter: (specifier: string) => boolean;
  /** Pass `-F` (fixed-string) instead of `-E` (extended regexp) to git grep. */
  fixed?: boolean;
  /** Pathspecs scoping the git grep (default ["*.ts", "*.tsx"]). */
  pathspecs?: string[];
}

/**
 * Find real-code static imports across the repo whose specifier passes `filter`,
 * ignoring occurrences that live in comments, strings or regex literals.
 *
 * `git grep -l` narrows the candidate file set fast; each candidate is then read
 * and scanned with `findImports`, which masks strings FULLY and reads the
 * specifier back by offset — so an import written *inside* a string/template
 * literal (a test fixture, a docs snippet, a codegen template) can never match.
 * String-safe by construction: no `maskStrings` knob is needed.
 */
export async function grepImports(
  opts: GrepImportsOptions,
): Promise<ImportMatch[]> {
  const pathspecs = opts.pathspecs ?? ["*.ts", "*.tsx"];

  const candidates = await readCandidates(
    opts.root,
    opts.grepArg,
    opts.fixed ?? false,
    pathspecs,
  );

  // Same shared-thread slicing as `grepCode`.
  const slice = createTimeSlicer();
  const matches: ImportMatch[] = [];
  for (const { rel, src } of candidates) {
    await slice();
    const origLines = src.split("\n");
    for (const imp of findImports(src)) {
      if (!opts.filter(imp.specifier)) continue;
      const line = lineAt(src, imp.index);
      const text = (origLines[line - 1] ?? "").replace(/\s+$/, "");
      matches.push({ path: rel, line, specifier: imp.specifier, text });
    }
  }
  return matches;
}

export interface CandidateSource {
  /** File path relative to `root`. */
  rel: string;
  /** The file's source text (read from the scan tree, or the working tree). */
  src: string;
}

export interface ListCandidateSourcesOptions {
  /** Repo root to scan (defaults to `git rev-parse --show-toplevel`). */
  root?: string;
  /** Narrows candidate files via `git grep -l` (fast pre-filter). */
  grepArg: string;
  /** Pass `-F` (fixed-string) instead of `-E` (extended regexp) to git grep. */
  fixed?: boolean;
  /** Pathspecs scoping the git grep (default ["*.ts", "*.tsx"]). */
  pathspecs?: string[];
}

/**
 * Public candidate-source lister: the scan-tree/untracked-aware file discovery
 * behind `grepCode`/`grepImports`, exposed for AST-based checks that parse each
 * candidate themselves (rather than regex-scanning lines). A thin pass-through
 * to `readCandidates` so the git plumbing — including seeing not-yet-committed
 * untracked files — stays single-sourced. A bare `git grep` searches only
 * tracked files and would miss a freshly-created source; use this instead.
 */
export async function listCandidateSources(
  opts: ListCandidateSourcesOptions,
): Promise<CandidateSource[]> {
  const root = opts.root ?? (await getWorktreeRoot());
  return readCandidates(
    root,
    opts.grepArg,
    opts.fixed ?? false,
    opts.pathspecs ?? ["*.ts", "*.tsx"],
  );
}

/**
 * Narrow candidate files via `git grep -l`, then read each one's source —
 * shared by `grepCode` (masked line re-scan) and `grepImports` (structured
 * import scan) so the git plumbing lives in one place.
 *
 * Every git failure throws (`GitScanError`) — a verdict built on a scan that
 * did not run would be vacuous.
 *
 * The cache key is computed from this tree-ish; scanning it (rather than the
 * working tree) guarantees a recorded PASS reflects the exact bytes hashed —
 * including files that were untracked when the cache entry was written. Null
 * (uncached / non-git run) falls back to the working tree.
 */
async function readCandidates(
  root: string,
  grepArg: string,
  fixed: boolean,
  pathspecs: string[],
): Promise<Array<{ rel: string; src: string }>> {
  const tree = currentScanTree();
  const view = currentScanView();
  const candidates = await gitGrepList(root, grepArg, fixed, pathspecs, tree);

  // Record this `git grep -l` selection + its pathspec fingerprint into the
  // ambient recording view (no-op when null — the legacy path). Recorded even
  // when the selection is EMPTY, which is the load-bearing case: a check that
  // PASSes today with zero matches (e.g. no-raw-websocket) must still invalidate
  // when the FIRST offender appears in a brand-new file — the empty query's
  // pathspec fingerprint changes, so `validate` re-runs `git grep -l` and sees
  // the new matcher (hazard H9). Recording only on non-empty selections would
  // leave the passing case with no guard → a stale PASS.
  view?.recordQuery(grepArg, fixed, pathspecs, candidates);
  if (candidates.length === 0) return [];

  const blobs = tree ? await readTreeBlobs(root, tree, candidates) : null;

  const out: Array<{ rel: string; src: string }> = [];
  for (const rel of candidates) {
    const src = blobs
      ? (blobs.get(rel) ?? null)
      : await readWorkingTreeFile(join(root, rel));
    if (src == null) continue;
    // Record a per-candidate CONTENT fact (its blobSha, taken from the snapshot —
    // no extra read; the BATCH `readTreeBlobs` above already loaded the bytes).
    // CRITICAL and non-obvious: a grepCode verdict depends on WHERE in each file
    // the token sits, not merely that the file matched `git grep -l`. A file that
    // matches in an ALLOWED location (PASS) can be edited so the token moves to a
    // DISALLOWED one — the match SET is unchanged, but the verdict must flip.
    // Only the recorded blobSha catches that; recording just the query match-set
    // would stale-PASS.
    view?.recordFile(rel);
    out.push({ rel, src });
  }
  return out;
}

/**
 * Run `git grep -l` to narrow the candidate file set — the SINGLE source of the
 * grep plumbing, shared by `readCandidates` (the scan choke-point) and the
 * runner's `validate` replay hook (which re-runs a recorded query against the
 * fresh snapshot tree). Keeping one implementation guarantees the recorded and
 * replayed selections are computed identically (same flags, same pathspec
 * framing, same `<tree>:`-prefix stripping).
 *
 * Exit 1 with no output is "no matches" and returns `[]`; every other failure
 * (exit 128 for a pattern git rejects, a bad pathspec or tree-ish; a timeout,
 * whose stdout may be a truncated list) throws `GitScanError`.
 */
export async function gitGrepList(
  root: string,
  grepArg: string,
  fixed: boolean,
  pathspecs: string[],
  tree: string | null,
): Promise<string[]> {
  // Against a tree: scan exactly its blobs. Without one (uncached fallback):
  // scan the working tree, adding `--untracked` so even an ad-hoc run still
  // sees not-yet-committed files. Paths from a tree-grep are prefixed with
  // `<tree>:`; strip it so callers always get repo-relative paths.
  const args = ["git", "grep", "-l", fixed ? "-F" : "-E"];
  if (!tree) args.push("--untracked");
  args.push(grepArg);
  if (tree) args.push(tree);
  args.push("--", ...pathspecs);

  const result = await spawnCaptured(args, {
    cwd: root,
    timeoutMs: GIT_SCAN_TIMEOUT_MS,
  });
  const stdout = result.stdout.trim();
  if (result.timedOut) throw new GitScanTimeoutError(args);
  if (result.exitCode === 1) {
    // `git grep`'s "no matches". Output alongside it would be incoherent.
    if (stdout === "") return [];
    throw new GitScanError(args, result, "exit 1 with output");
  }
  if (result.exitCode !== 0) throw new GitScanError(args, result);
  if (stdout === "") return [];

  const prefix = tree ? `${tree}:` : "";
  return stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (prefix && l.startsWith(prefix) ? l.slice(prefix.length) : l));
}

// Read each candidate's content straight from the tree object via a single
// `git cat-file --batch` (one spawn, not one per file). The batch protocol
// frames each object as `<sha> <type> <size>\n<size bytes>\n`, or
// `<spec> missing\n`; outputs come back in request order.
async function readTreeBlobs(
  root: string,
  tree: string,
  paths: string[],
): Promise<Map<string, string>> {
  const requests = paths.map((p) => `${tree}:${p}`).join("\n") + "\n";
  // Whole-buffer stdin + after-exit stdoutBytes: the parser below already walks
  // a fully-buffered Uint8Array, so the batch framing is unchanged by the move
  // off piped stdio.
  const argv = ["git", "cat-file", "--batch"];
  const result = await spawnCaptured(argv, {
    cwd: root,
    stdin: requests,
    timeoutMs: GIT_SCAN_TIMEOUT_MS,
  });
  if (result.timedOut) throw new GitScanTimeoutError(argv);
  if (result.exitCode !== 0) throw new GitScanError(argv, result);
  const buf = result.stdoutBytes;

  const decoder = new TextDecoder();
  const out = new Map<string, string>();
  let i = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0)
      throw new GitScanError(argv, result, `output ends before \`${p}\``);
    const header = decoder.decode(buf.subarray(i, nl));
    i = nl + 1;
    // The object is absent from the tree — a legitimate answer, not a failure.
    if (header.endsWith(" missing")) continue;
    const size = Number.parseInt(header.split(" ")[2] ?? "", 10);
    // Framing desync or a short stream: stop rather than mis-slice, and say so
    // rather than hand back a map missing every candidate after this one.
    if (!Number.isFinite(size) || i + size > buf.length)
      throw new GitScanError(
        argv,
        result,
        `unreadable object header \`${header}\` for \`${p}\``,
      );
    out.set(p, decoder.decode(buf.subarray(i, i + size)));
    i += size + 1; // content + trailing newline
  }
  return out;
}

// Working-tree fallback read. `git grep --untracked` listed the file, so only a
// deletion in between (ENOENT) is a legitimate skip; any other read failure
// would silently drop a candidate from the verdict.
async function readWorkingTreeFile(abs: string): Promise<string | null> {
  try {
    return await Bun.file(abs).text();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}
