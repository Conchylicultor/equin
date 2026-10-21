import { isAbsolute, relative, resolve } from "node:path";
import { GIT, HOME_DIR } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { ResolvedFile } from "../../shared/resolved-file";

// Every git read in this file answers a file-peek pane waiting on its
// resolution: a local metadata read that finishes in milliseconds. Thirty
// seconds is well past the point where an answer still helps whoever is
// looking at the pane — so only a wedged child reaches it, and it fails as a
// named error instead of holding the load open forever.
const GIT_TIMEOUT_MS = 30_000;

function expandTilde(path: string): string {
  if (path === "~") return HOME_DIR;
  if (path.startsWith("~/")) return resolve(HOME_DIR, path.slice(2));
  return path;
}

function isSubsequence(query: string[], file: string[]): boolean {
  let qi = 0;
  for (let fi = 0; fi < file.length && qi < query.length; fi++) {
    if (file[fi] === query[qi]) qi++;
  }
  return qi === query.length;
}

function isSuffixMatch(query: string[], file: string[]): boolean {
  if (query.length > file.length) return false;
  const offset = file.length - query.length;
  for (let i = 0; i < query.length; i++) {
    if (file[offset + i] !== query[i]) return false;
  }
  return true;
}

/**
 * Where `rawPath` resolves in the workspace at `wtPath` (see
 * `ResolvedFileSchema`): an existing file named exactly, else — in a git
 * checkout (`checkout`) — the checkout's files (`git ls-files`, tracked and
 * untracked-not-ignored) whose segments hold the query's as a subsequence —
 * suffix matches first, each group shortest first. `maxMatches` caps the
 * `resolved` list; `total` counts every match. A workspace that is not a
 * checkout (a scratch dir) has no file list to match against: a path that
 * names nothing there is `not-found`.
 */
export async function resolveFilePath(
  wtPath: string,
  rawPath: string,
  maxMatches: number,
  checkout = true,
): Promise<ResolvedFile> {
  if (!rawPath || rawPath.includes("\0")) return { kind: "not-found" };

  const cleaned = cleanQuery(rawPath);
  if (!cleaned) return { kind: "not-found" };

  const absTarget = targetOf(wtPath, cleaned);
  if (await Bun.file(absTarget).exists()) {
    // Inside the worktree → a checkout-relative path (code-api reads only
    // those); anywhere else → the absolute path, for host-fs to read.
    const rel = relative(resolve(wtPath), absTarget);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
      ? { kind: "exact", source: "git", path: rel }
      : { kind: "exact", source: "host", path: absTarget };
  }

  // ~-rooted and absolute paths are not in the git tree; skip ls-files
  if (cleaned.startsWith("/") || !checkout) return { kind: "not-found" };

  const result = await spawnCaptured(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      wtPath,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) return { kind: "not-found" };
  const out = result.stdout;

  const querySeg = cleaned.split("/").filter((s) => s !== "...");
  const matches: string[] = [];

  for (const line of out.split("\n")) {
    if (!line) continue;
    const fileSeg = line.split("/");
    if (isSubsequence(querySeg, fileSeg)) {
      matches.push(line);
    }
  }

  if (matches.length === 0) return { kind: "not-found" };

  const suffix: string[] = [];
  const rest: string[] = [];
  for (const m of matches) {
    if (isSuffixMatch(querySeg, m.split("/"))) suffix.push(m);
    else rest.push(m);
  }

  if (suffix.length === 1) {
    return { kind: "resolved", matches: suffix, total: 1 };
  }

  const sorted = [
    ...suffix.sort((a, b) => a.length - b.length),
    ...rest.sort((a, b) => a.length - b.length),
  ];
  return {
    kind: "resolved",
    matches: sorted.slice(0, maxMatches),
    total: sorted.length,
  };
}

/**
 * The absolute path a cleaned query names when read as a path: itself when
 * absolute, else under the checkout — the entry whose existence makes it an
 * `exact` answer.
 */
export function targetOf(wtPath: string, cleaned: string): string {
  return cleaned.startsWith("/") ? resolve(cleaned) : resolve(wtPath, cleaned);
}

/** The query as a path: `./` dropped, `~` expanded. */
export function cleanQuery(rawPath: string): string {
  return expandTilde(rawPath.replace(/^\.\//, ""));
}
