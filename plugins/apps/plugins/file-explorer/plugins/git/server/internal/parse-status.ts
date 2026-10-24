import type { NameStatusRecord } from "@plugins/primitives/plugins/commit-list/server";
import {
  GIT_STATUS_MAX_PATHS,
  type GitChange,
  type GitEntry,
  type GitStatus,
} from "../../shared/resources";

/** What `git status --porcelain=v2 -z --branch` says, before main is folded in. */
export interface PorcelainStatus {
  /** `# branch.oid`; `null` on an unborn branch (`(initial)`). */
  head: string | null;
  /** Each tracked path changed vs HEAD (index and worktree together). */
  vsHead: Map<string, GitChange>;
  untrackedFiles: string[];
  untrackedDirs: string[];
  ignoredFiles: string[];
  ignoredDirs: string[];
}

/** `n` space-separated fields, then the rest of the record (a path may hold spaces). */
function fieldsThenPath(record: string, n: number): [string[], string] {
  const fields: string[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const cut = record.indexOf(" ", at);
    if (cut < 0)
      throw new Error(`git status: malformed record ${JSON.stringify(record)}`);
    fields.push(record.slice(at, cut));
    at = cut + 1;
  }
  return [fields, record.slice(at)];
}

/**
 * An ordinary changed path's status vs HEAD from its `XY` (index vs HEAD,
 * worktree vs index). `null` for a path added to the index then deleted from
 * the worktree: it exists neither in HEAD nor on disk.
 */
function changeOf(xy: string): GitChange | null {
  const x = xy[0];
  const y = xy[1];
  if (x === "D" || y === "D") return x === "A" ? null : "deleted";
  if (x === "A") return "added";
  return "modified";
}

/** Split a collapsed listing into directories (`dir/`) and files. */
function pushPath(path: string, dirs: string[], files: string[]): void {
  if (path.endsWith("/")) dirs.push(path.slice(0, -1));
  else files.push(path);
}

/**
 * Parse `git status --porcelain=v2 -z --branch --untracked-files=normal
 * --ignored=matching`. Untracked and ignored directories arrive collapsed as
 * `dir/`; a rename (`2`) record is followed by its original path, which is not
 * on disk and so is not reported.
 */
export function parsePorcelainV2Z(out: string): PorcelainStatus {
  const result: PorcelainStatus = {
    head: null,
    vsHead: new Map(),
    untrackedFiles: [],
    untrackedDirs: [],
    ignoredFiles: [],
    ignoredDirs: [],
  };
  const records = out.split("\0");
  if (records.at(-1) === "") records.pop();
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    switch (record.charAt(0)) {
      case "#": {
        const oid = /^# branch\.oid (.+)$/.exec(record);
        if (oid) result.head = oid[1] === "(initial)" ? null : oid[1]!;
        break;
      }
      case "1": {
        const [fields, path] = fieldsThenPath(record, 8);
        const change = changeOf(fields[1]!);
        if (change !== null) result.vsHead.set(path, change);
        break;
      }
      case "2": {
        const [fields, path] = fieldsThenPath(record, 9);
        i++; // the original path
        const xy = fields[1]!;
        result.vsHead.set(
          path,
          xy[1] === "D" ? "deleted" : xy[0] === "C" ? "copied" : "renamed",
        );
        break;
      }
      case "u": {
        const [, path] = fieldsThenPath(record, 10);
        result.vsHead.set(path, "modified");
        break;
      }
      case "?":
        pushPath(record.slice(2), result.untrackedDirs, result.untrackedFiles);
        break;
      case "!":
        pushPath(record.slice(2), result.ignoredDirs, result.ignoredFiles);
        break;
      default:
        throw new Error(`git status: unknown record ${JSON.stringify(record)}`);
    }
  }
  return result;
}

/**
 * The wire status: the porcelain read vs HEAD, with each path's status vs the
 * main merge-base (`diff <mergeBase> --name-status`, which covers tracked
 * paths; an untracked file is untracked vs main too). Each list keeps its first
 * `maxPaths` (the schema's cap); `truncated` says one was cut.
 */
export function assembleStatus(
  porcelain: PorcelainStatus,
  mergeBase: string | null,
  vsMain: readonly NameStatusRecord[],
  maxPaths: number = GIT_STATUS_MAX_PATHS,
): GitStatus {
  const entries: Record<string, GitEntry> = {};
  const entry = (path: string): GitEntry =>
    (entries[path] ??= { vsHead: null, vsMain: null });
  for (const [path, change] of porcelain.vsHead) entry(path).vsHead = change;
  for (const rec of vsMain) entry(rec.path).vsMain = rec.status;
  for (const path of porcelain.untrackedFiles) {
    entries[path] = {
      vsHead: "untracked",
      vsMain: mergeBase === null ? null : "untracked",
    };
  }
  const paths = Object.keys(entries);
  const lists = [
    porcelain.untrackedDirs,
    porcelain.ignoredDirs,
    porcelain.ignoredFiles,
  ];
  const truncated =
    paths.length > maxPaths || lists.some((l) => l.length > maxPaths);
  return {
    head: porcelain.head,
    mergeBase,
    entries: truncated
      ? Object.fromEntries(
          paths.slice(0, maxPaths).map((p) => [p, entries[p]!]),
        )
      : entries,
    untrackedDirs: porcelain.untrackedDirs.slice(0, maxPaths),
    ignoredDirs: porcelain.ignoredDirs.slice(0, maxPaths),
    ignoredFiles: porcelain.ignoredFiles.slice(0, maxPaths),
    truncated,
  };
}
