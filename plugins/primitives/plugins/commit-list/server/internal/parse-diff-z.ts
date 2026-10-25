/** A path's status in a `git diff --name-status` between two trees. */
export type DiffNameStatus =
  "added" | "deleted" | "modified" | "renamed" | "copied";

export interface NameStatusRecord {
  status: DiffNameStatus;
  path: string;
  from?: string;
}

export interface NumstatRecord {
  additions: number;
  deletions: number;
  path: string;
  from?: string;
  /** `-\t-`: a binary file, its counts 0. */
  binary: boolean;
}

// `git diff -z --name-status` emits NUL-separated fields:
//   "<code>\0<path>\0"             for A/M/D/T
//   "<code><score>\0<old>\0<new>\0" for R<score>/C<score>
// We walk forward and consume one or two extra tokens per record based on the
// leading code letter.
export function parseDiffNameStatusZ(out: string): NameStatusRecord[] {
  const tokens = splitNul(out);
  const result: NameStatusRecord[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i]![0]!;
    if (code === "R" || code === "C") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath === undefined || newPath === undefined) break;
      result.push({
        status: code === "R" ? "renamed" : "copied",
        path: newPath,
        from: oldPath,
      });
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path === undefined) break;
      result.push({ status: mapSimpleStatus(code), path });
      i += 2;
    }
  }
  return result;
}

// `git diff -z --numstat` emits
//   "<add>\t<del>\t<path>\0"           for unchanged paths
//   "<add>\t<del>\t\0<old>\0<new>\0"   for renames/copies (path field empty)
export function parseDiffNumstatZ(out: string): NumstatRecord[] {
  const tokens = splitNul(out);
  const result: NumstatRecord[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i]!;
    const parts = head.split("\t");
    if (parts.length < 3) {
      i++;
      continue;
    }
    const add = toCount(parts[0]!);
    const del = toCount(parts[1]!);
    const binary = parts[0] === "-" && parts[1] === "-";
    // A path may itself hold a tab: everything after the second one.
    const path = parts.slice(2).join("\t");
    if (path === "") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath === undefined || newPath === undefined) break;
      result.push({
        additions: add,
        deletions: del,
        path: newPath,
        from: oldPath,
        binary,
      });
      i += 3;
    } else {
      result.push({ additions: add, deletions: del, path, binary });
      i += 1;
    }
  }
  return result;
}

/** One path of a `git diff -z --raw --numstat`: its status and its line counts. */
export interface RawNumstatRecord {
  status: DiffNameStatus;
  path: string;
  from?: string;
  additions: number;
  deletions: number;
  /** Numstat said `-\t-`: a binary file, its counts 0. */
  binary: boolean;
}

// `git diff -z --raw --numstat` emits every raw record first, then every
// numstat record, with no separator between the two sections:
//   ":<srcmode> <dstmode> <srcsha> <dstsha> <code>\0<path>\0"         A/M/D/T/U/X
//   ":<srcmode> <dstmode> <srcsha> <dstsha> <code><score>\0<old>\0<new>\0" R/C
//   "<add>\t<del>\t<path>\0" / "<add>\t<del>\t\0<old>\0<new>\0"  numstat
// A raw head starts with ":", a numstat head with a digit or "-", and paths
// are consumed positionally — so a path starting with ":" or holding a tab or
// newline cannot be misread. One diff gives both the status and the counts.
export function parseDiffRawNumstatZ(out: string): RawNumstatRecord[] {
  const tokens = splitNul(out);
  const byPath = new Map<string, RawNumstatRecord>();
  let i = 0;
  while (i < tokens.length && tokens[i]!.startsWith(":")) {
    const head = tokens[i]!;
    const code = head.slice(head.lastIndexOf(" ") + 1)[0];
    if (code === undefined)
      throw new Error(`[git diff --raw] bad record: ${head}`);
    const base = { additions: 0, deletions: 0, binary: false };
    if (code === "R" || code === "C") {
      const from = tokens[i + 1];
      const path = tokens[i + 2];
      if (from === undefined || path === undefined) {
        throw new Error(`[git diff --raw] truncated ${code} record: ${head}`);
      }
      byPath.set(path, {
        status: code === "R" ? "renamed" : "copied",
        path,
        from,
        ...base,
      });
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path === undefined) {
        throw new Error(`[git diff --raw] truncated record: ${head}`);
      }
      byPath.set(path, { status: mapSimpleStatus(code), path, ...base });
      i += 2;
    }
  }
  for (const rec of parseDiffNumstatZ(tokens.slice(i).join("\0"))) {
    const entry = byPath.get(rec.path);
    // Both sections describe one diff: a count with no status means the
    // layout is not the one parsed here.
    if (entry === undefined) {
      throw new Error(`[git diff --numstat] ${rec.path} has no --raw record`);
    }
    entry.additions = rec.additions;
    entry.deletions = rec.deletions;
    entry.binary = rec.binary;
  }
  return [...byPath.values()];
}

function splitNul(out: string): string[] {
  const tokens = out.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  return tokens;
}

function toCount(s: string): number {
  // "-" means binary; treat as 0.
  if (s === "-") return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function mapSimpleStatus(code: string): DiffNameStatus {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  return "modified";
}
