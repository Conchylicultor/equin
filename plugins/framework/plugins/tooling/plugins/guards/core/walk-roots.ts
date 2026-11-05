import { operandPath, parseArgv } from "./argv";
import type { ParsedArgv } from "./argv";
import type { ShellCall } from "./parse-shell";

/**
 * Which directories a search / walk command descends into — the `argv.ts` of
 * reads, for the one kind of read that is dangerous by SIZE: a recursive walk.
 *
 * `rg foo ../../../../../../../` from a worktree walks the whole home directory
 * (9 GB of transcripts, every worktree's node_modules), churning the kernel file
 * cache every other process on the host shares. What decides the cost is the
 * ROOT, so that is what this module extracts: each root resolved against the
 * call's cwd (a missing path operand is the cwd itself), plus the facts that
 * bound the walk below it.
 */
export interface Walk {
  /** The command as typed (`rg`, `grep`, …), for the denial message. */
  command: string;
  /** Every directory the walk starts from, resolved. Never empty. */
  roots: WalkRoot[];
  /**
   * An explicit depth bound (`rg --max-depth 1`, `find -maxdepth 1`, `tree -L
   * 1`), or `null` when the walk goes all the way down.
   */
  maxDepth: number | null;
  /**
   * The walk skips gitignored and hidden entries (rg / fd / ag by default) —
   * which is what keeps a walk of the main checkout out of `.claude/worktrees`.
   */
  honoursIgnores: boolean;
  /** It opens and reads the files it finds, not just their names. */
  readsContent: boolean;
}

export interface WalkRoot {
  /** As typed — `""` when the root is the implicit cwd. */
  raw: string;
  /**
   * The directory walked — for a glob, the fixed part before its first glob
   * segment: the one directory every expansion lies inside.
   */
  path: string;
  /**
   * A glob with ONE glob segment, which the shell expands into the entries of
   * `path` matching `segment`, each followed by `rest`. Judging only `path`
   * would refuse `rg foo ~/.equin/logs/gateway/*.log` — a list of files — the
   * same as `rg foo ~/.claude/projects/*`, a walk of every project; the
   * entries tell them apart.
   */
  expands?: { segment: RegExp; rest: string };
}

/**
 * The shell expands a glob before the command sees it, into anything it
 * matches — so `~/.claude/projects/*` walks every project.
 */
const GLOB_CHARS = /[*?[{]/;

const escapeRe = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One path segment's glob as an anchored regex (`*`, `?`, `[…]`, `{a,b}`). */
function segmentRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        continue;
      }
      const body = glob
        .slice(i + 1, close)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\");
      re += `[${body}]`;
      i = close;
    } else if (ch === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
        continue;
      }
      re += `(?:${glob
        .slice(i + 1, close)
        .split(",")
        .map(escapeRe)
        .join("|")})`;
      i = close;
    } else re += escapeRe(ch);
  }
  // The shell matches a leading dot only when the glob spells one.
  return new RegExp(glob.startsWith(".") ? `^${re}$` : `^(?!\\.)${re}$`);
}

/** A brace alternative spanning a `/` (`~/{.claude/projects,Downloads}`). */
const BRACE_WITH_SLASH = /\{[^}]*\/[^}]*\}/;

function rootOf(raw: string, cwd: string): WalkRoot {
  // Splitting on `/` would tear the alternatives apart into segments that
  // match nothing: judge the directory before the brace instead.
  const brace = BRACE_WITH_SLASH.exec(raw);
  if (brace) {
    const before = raw.slice(0, brace.index);
    const dir = before.slice(0, before.lastIndexOf("/") + 1);
    return {
      raw,
      path:
        dir === ""
          ? cwd
          : dir === "/"
            ? "/"
            : operandPath(dir.slice(0, -1), cwd),
    };
  }
  const segments = raw.split("/");
  const globAt = segments.flatMap((s, i) => (GLOB_CHARS.test(s) ? [i] : []));
  if (globAt.length === 0) return { raw, path: operandPath(raw, cwd) };
  const first = globAt[0]!;
  const fixed = segments.slice(0, first).join("/");
  // `/*` → "" before the glob: the filesystem root, not the cwd.
  const path =
    fixed === "" && raw.startsWith("/") ? "/" : operandPath(fixed, cwd);
  if (globAt.length > 1) return { raw, path };
  let segment: RegExp;
  try {
    segment = segmentRegex(segments[first]!);
  } catch (err) {
    // A bracket the shell reads and a regex refuses (`[z-a]`): judge the
    // fixed directory alone, the stricter answer.
    if (err instanceof SyntaxError) return { raw, path };
    throw err;
  }
  return {
    raw,
    path,
    expands: { segment, rest: segments.slice(first + 1).join("/") },
  };
}

function depthOf(argv: ParsedArgv, ...names: string[]): number | null {
  for (const name of names) {
    const v = argv.values.get(name);
    if (v !== undefined && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

const hasAny = (argv: ParsedArgv, ...names: string[]): boolean =>
  names.some((n) => argv.flags.has(n));

/** Operands (globs folded to their fixed prefix), or the cwd when there are none. */
function operandRoots(
  call: ShellCall,
  argv: ParsedArgv,
  extra: string[] = [],
): WalkRoot[] {
  const raws = [
    ...argv.files.flatMap((o) => (o.kind === "local" ? [o.raw] : [])),
    ...extra,
  ];
  if (raws.length === 0) return [{ raw: "", path: call.cwd }];
  return raws.map((r) => rootOf(r, call.cwd));
}

// `find [-H|-L|-P|-E|-X|-s|-x|-d] [-f path] path... expression`: its roots are
// the operands before the first expression token, which no flag table models.
const FIND_OPTIONS = new Set(["-H", "-L", "-P", "-E", "-X", "-s", "-x", "-d"]);

function findWalk(call: ShellCall): Walk {
  const raws: string[] = [];
  let i = 0;
  for (; i < call.args.length; i++) {
    const a = call.args[i]!;
    if (FIND_OPTIONS.has(a)) continue;
    if (a === "-f") {
      const v = call.args[++i];
      if (v !== undefined) raws.push(v);
      continue;
    }
    if (a.startsWith("-") || a === "(" || a === "!" || a === "\\(") break;
    raws.push(a);
  }
  const at = call.args.indexOf("-maxdepth");
  const depth = at === -1 ? undefined : call.args[at + 1];
  return {
    command: call.name,
    roots:
      raws.length === 0
        ? [{ raw: "", path: call.cwd }]
        : raws.map((r) => rootOf(r, call.cwd)),
    maxDepth: depth !== undefined && /^\d+$/.test(depth) ? Number(depth) : null,
    honoursIgnores: false,
    readsContent: false,
  };
}

const GREP_NAMES = new Set(["grep", "egrep", "fgrep", "ggrep"]);

/**
 * The walk `call` performs, or `null` when it walks nothing: not a search
 * command, a grep without `-r`, an `ls` without `-R`, a search reading the
 * pipe on its stdin.
 */
export function walkOf(call: ShellCall): Walk | null {
  const name = call.name;
  if (name === "find" || name === "gfind" || name === "bfs")
    return findWalk(call);

  if (name === "rg" || name === "ripgrep") {
    const argv = parseArgv({ ...call, name: "rg" });
    if (hasAny(argv, "version", "V", "help", "type-list")) return null;
    // `--files` lists the cwd whatever is piped in; a search reads the pipe.
    if (call.pipedIn && argv.files.length === 0 && !argv.flags.has("files"))
      return null;
    return {
      command: name,
      roots: operandRoots(call, argv),
      maxDepth: depthOf(argv, "max-depth", "maxdepth", "d"),
      honoursIgnores: !hasAny(
        argv,
        "u",
        "unrestricted",
        "no-ignore",
        "no-ignore-vcs",
      ),
      readsContent: !argv.flags.has("files"),
    };
  }

  if (GREP_NAMES.has(name)) {
    const argv = parseArgv({ ...call, name: "grep" });
    const recursive =
      hasAny(argv, "r", "R", "recursive", "dereference-recursive") ||
      argv.values.get("d") === "recurse" ||
      argv.values.get("directories") === "recurse";
    if (!recursive) return null;
    if (call.pipedIn && argv.files.length === 0) return null;
    return {
      command: name,
      roots: operandRoots(call, argv),
      maxDepth: null,
      honoursIgnores: false,
      readsContent: true,
    };
  }

  if (name === "fd" || name === "fdfind") {
    const argv = parseArgv({ ...call, name: "fd" });
    if (hasAny(argv, "version", "V", "help")) return null;
    const searchPath = argv.values.get("search-path");
    const base = argv.values.get("base-directory");
    const cwd = base === undefined ? call.cwd : operandPath(base, call.cwd);
    return {
      command: name,
      roots: operandRoots(
        { ...call, cwd },
        argv,
        searchPath === undefined ? [] : [searchPath],
      ),
      maxDepth: depthOf(argv, "max-depth", "d", "exact-depth"),
      honoursIgnores: !hasAny(
        argv,
        "u",
        "unrestricted",
        "I",
        "no-ignore",
        "no-ignore-vcs",
      ),
      readsContent: false,
    };
  }

  if (name === "ag") {
    const argv = parseArgv(call);
    if (call.pipedIn && argv.files.length === 0) return null;
    return {
      command: name,
      roots: operandRoots(call, argv),
      maxDepth: depthOf(argv, "depth"),
      honoursIgnores: !hasAny(
        argv,
        "u",
        "U",
        "unrestricted",
        "skip-vcs-ignores",
      ),
      readsContent: true,
    };
  }

  if (name === "tree") {
    const argv = parseArgv(call);
    return {
      command: name,
      roots: operandRoots(call, argv),
      maxDepth: depthOf(argv, "L"),
      honoursIgnores: argv.flags.has("gitignore"),
      readsContent: false,
    };
  }

  if (name === "du" || name === "gdu") {
    const argv = parseArgv({ ...call, name: "du" });
    return {
      command: name,
      roots: operandRoots(call, argv),
      // `du -d N` bounds what it PRINTS; it still stats the whole tree.
      maxDepth: null,
      honoursIgnores: false,
      readsContent: false,
    };
  }

  if (name === "ls" || name === "gls") {
    const argv = parseArgv({ ...call, name: "ls" });
    if (!hasAny(argv, "R", "recursive")) return null;
    return {
      command: name,
      roots: operandRoots(call, argv),
      maxDepth: null,
      honoursIgnores: false,
      readsContent: false,
    };
  }

  return null;
}

/**
 * The walk of a Claude Code `Grep` / `Glob` call — ripgrep under another name
 * (gitignored and hidden entries skipped). `path` is the root (the cwd when
 * absent), however narrow the pattern: a relative Glob pattern is a filter over
 * that walk, not a place below it. Only an absolute Glob pattern names a root
 * of its own.
 */
export function searchToolWalk(
  tool: "Grep" | "Glob",
  input: { path?: string; pattern?: string },
  cwd: string,
): Walk {
  const base = input.path ? operandPath(input.path, cwd) : cwd;
  const root =
    tool === "Glob" &&
    input.pattern &&
    /^(?:\/|~|\$HOME|\$\{HOME\})/.test(input.pattern)
      ? rootOf(input.pattern, base)
      : { raw: input.path ?? "", path: base };
  return {
    command: tool,
    roots: [root],
    maxDepth: null,
    honoursIgnores: true,
    readsContent: tool === "Grep",
  };
}
