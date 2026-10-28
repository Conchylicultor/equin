import { basename, resolve } from "node:path";
import type { ShellCall } from "./parse-shell";

/**
 * Splits one shell call's argv into flags and the operands that NAME A FILE.
 *
 * Guards used to do this with `call.args.filter((a) => !a.startsWith("-"))` and
 * then `resolve(call.cwd, …)` on the survivors. That is not a parse, it is a
 * guess: every token that is not flag-shaped becomes a path. A `sed -i ''
 * 's|resolve(HERE, "../../../..");|…|' cli/equin-cli.ts` was blocked as a
 * write to the main checkout, because `path.resolve` normalised the `..`
 * sequences INSIDE the substitution script and landed them under the repo root.
 * The same guess also missed real writes — `cp -t <main> a.ts` treats the
 * destination as a flag, `rm -- -weird` filters the operand away as one.
 *
 * So a per-command table records which flags take a value and which of those
 * values is a destination, and the walk below is the one place that knows how
 * an argv is shaped. No guard invents a path from a token again.
 *
 * ## Totality
 *
 * `parseArgv` never throws and always answers. An unknown command falls through
 * to an empty grammar, which reproduces the old behaviour exactly: `-`-leading
 * tokens are flags, everything else is an operand. This runs inside a PreToolUse
 * hook on every single Bash call, so a command nobody modelled must parse
 * conservatively rather than fail the tool call.
 *
 * `files: []` is legitimate emptiness, not an absorbed failure: `git status` and
 * a `sed` without `-i` genuinely write nothing. There is no failure arm to
 * confuse it with — the answer to "which operands name a file" is a list, and
 * for many commands that list is correctly empty.
 *
 * ## Resolved paths, not raw strings
 *
 * `parse-shell.ts` already warns that a call's relative args must be resolved
 * against `call.cwd` or `cd <dir> && rm <rel>` slips past. Doing the resolve
 * here makes that unforgettable. `raw` is kept beside the resolved path so a
 * guard's message can echo what the agent actually typed.
 *
 * There is deliberately no `reads` output. No caller needs one, and a partial
 * one would be a half-truth: `sed -i` reads its input files too, so a read set
 * built from `-r`/`-f`/`--reference` alone would systematically understate.
 */

export type FileOperand =
  /** A path on this machine, already resolved against the call's cwd. */
  | { kind: "local"; raw: string; path: string }
  /** An `[user@]host:path` spec (rsync/scp): nothing local is touched. */
  | { kind: "remote"; raw: string }
  /**
   * What a link will POINT AT (`ln`'s target operands): never opened, never
   * written, and deliberately unresolved — a relative `ln -s` target is read
   * from the LINK's folder, not the cwd, so a `path` here would be wrong as
   * well as irrelevant. Having none is what keeps `cd <main> && ln -s .equin
   * ~/.x` from reading as a write to `<main>/.equin`.
   */
  | { kind: "link-target"; raw: string };

export interface ParsedArgv {
  /** Positional operands that name a file, in argv order. */
  files: FileOperand[];
  /** An explicit destination directory: `-t` / `--target-directory`, `git -C`. */
  targetDir?: FileOperand;
  /**
   * The first positional when the command spends it on something that is not a
   * file — a sed script, a chmod mode, a git subcommand. RAW, never resolved:
   * resolving it is precisely the bug this module exists to remove.
   */
  leading?: string;
  /**
   * Every flag seen AS A FLAG: short letters bare (`"i"`), long names undashed
   * (`"in-place"`). A letter that was consumed as another flag's value is
   * absent, which is what makes `sed -ei 'x' f` correctly NOT in-place.
   */
  flags: ReadonlySet<string>;
}

/**
 * What a flag does with the token that follows it.
 *
 * - `consumed` — takes the next token (or its cluster tail), and that value is
 *   NEVER a write target: a mode, a size, a date, a suffix, a script, or a path
 *   that is only READ. Non-paths and read-paths share one arity on purpose —
 *   both leave the write set, and an axis no consumer observes is an axis that
 *   rots. Which is which is recorded per entry in a comment.
 * - `dir` — takes the next token, and that token IS the destination directory.
 * - `attached` — an optional value that must be glued to the flag (`-i.bak`,
 *   `--backup=simple`). It never takes the next token, or `cp --backup a b`
 *   would lose `a` as an operand.
 */
type FlagArity = "consumed" | "dir" | "attached";

interface CommandGrammar {
  /** Single letters, as they appear inside a `-abc` cluster. */
  short?: Record<string, FlagArity>;
  /** Long names without the leading `--`. */
  long?: Record<string, FlagArity>;
  /** The command spends its first positional on a non-file (see `leading`). */
  leading?: { suppressedBy?: readonly string[] };
  /**
   * A `-`-leading token that is the leading operand rather than a flag cluster
   * (chmod's symbolic mode `-w`). Tested before the cluster walk.
   */
  leadingPattern?: RegExp;
  /** `[user@]host:path` operands are remote specs, not local paths. */
  remoteSpecs?: true;
  /**
   * `ln`'s operand shape: every operand is a link target except the one place
   * the link is created — none under a `dir` flag (`ln -t DIR T...`), else the
   * last (`ln T LINK`, `ln T... DIR`). A lone operand (`ln T`) creates
   * `<cwd>/basename(T)`, which is added as the destination.
   */
  links?: true;
}

const COMMAND_GRAMMAR = {
  // `-S`/`--suffix` is a backup suffix; the `attached` longs all take an
  // OPTIONAL glued value, so they must not eat the next token.
  cp: {
    short: { t: "dir", S: "consumed" },
    long: {
      "target-directory": "dir",
      suffix: "consumed",
      backup: "attached",
      preserve: "attached",
      "no-preserve": "attached",
      sparse: "attached",
      context: "attached",
      reflink: "attached",
      update: "attached",
    },
  },
  mv: {
    short: { t: "dir", S: "consumed" },
    long: {
      "target-directory": "dir",
      suffix: "consumed",
      backup: "attached",
      context: "attached",
      update: "attached",
    },
  },
  // `-m`/`-o`/`-g` are mode/owner/group, `-B` a suffix, `-f` install's own
  // "strip file" argument — none of them a path this call writes.
  install: {
    short: {
      t: "dir",
      m: "consumed",
      o: "consumed",
      g: "consumed",
      B: "consumed",
      f: "consumed",
    },
    long: {
      "target-directory": "dir",
      mode: "consumed",
      owner: "consumed",
      group: "consumed",
      suffix: "consumed",
      "strip-program": "consumed",
      backup: "attached",
      context: "attached",
    },
  },
  // rsync's value flags are mostly filter/limit settings; the path-valued ones
  // (`--exclude-from`, `--files-from`, `--temp-dir`, `--*-dest`, `--log-file`)
  // are read or written OUTSIDE the transfer's destination, so keeping them out
  // of the operand list is what stops them stealing the "last operand" slot.
  rsync: {
    short: {
      e: "consumed",
      f: "consumed",
      T: "consumed",
      B: "consumed",
      M: "consumed",
    },
    long: {
      rsh: "consumed",
      exclude: "consumed",
      include: "consumed",
      filter: "consumed",
      "exclude-from": "consumed",
      "include-from": "consumed",
      "files-from": "consumed",
      "temp-dir": "consumed",
      "backup-dir": "consumed",
      "partial-dir": "consumed",
      "compare-dest": "consumed",
      "copy-dest": "consumed",
      "link-dest": "consumed",
      chmod: "consumed",
      chown: "consumed",
      usermap: "consumed",
      groupmap: "consumed",
      timeout: "consumed",
      contimeout: "consumed",
      bwlimit: "consumed",
      port: "consumed",
      "password-file": "consumed",
      "rsync-path": "consumed",
      "out-format": "consumed",
      "log-file": "consumed",
      "log-file-format": "consumed",
      suffix: "consumed",
      "max-size": "consumed",
      "min-size": "consumed",
      "block-size": "consumed",
      "modify-window": "consumed",
      "write-batch": "consumed",
      "read-batch": "consumed",
      "remote-option": "consumed",
      info: "consumed",
      debug: "consumed",
      outbuf: "consumed",
      iconv: "consumed",
      protocol: "consumed",
      sockopts: "consumed",
      address: "consumed",
      "max-delete": "consumed",
      "checksum-seed": "consumed",
    },
    remoteSpecs: true,
  },
  rm: { long: { interactive: "attached" } },
  rmdir: {},
  tee: { long: { "output-error": "attached" } },
  // `-r`/`--reference` is a file whose timestamp is COPIED, never written.
  touch: {
    short: { d: "consumed", t: "consumed", r: "consumed", A: "consumed" },
    long: { date: "consumed", time: "consumed", reference: "consumed" },
  },
  mkdir: {
    short: { m: "consumed" },
    long: { mode: "consumed", context: "attached" },
  },
  // The `leadingPattern` is load-bearing, not cosmetic: without it `chmod -w f`
  // would spend `f` on the mode slot and become a NEW under-block. The letter
  // set is disjoint from every real chmod flag on GNU (`c f v R`) and BSD
  // (`f H h L P R v C N E I`), so a genuine flag can never match it.
  chmod: {
    long: { reference: "consumed" },
    leading: { suppressedBy: ["reference"] },
    leadingPattern: /^-[rwxXstugoa]+$/,
  },
  chown: {
    long: { reference: "consumed", from: "consumed" },
    leading: { suppressedBy: ["reference"] },
  },
  chgrp: {
    long: { reference: "consumed" },
    leading: { suppressedBy: ["reference"] },
  },
  truncate: {
    short: { s: "consumed", r: "consumed" },
    long: { size: "consumed", reference: "consumed" },
  },
  shred: {
    short: { n: "consumed", s: "consumed" },
    long: {
      iterations: "consumed",
      size: "consumed",
      "random-source": "consumed",
      remove: "attached",
    },
  },
  ln: {
    short: { t: "dir", S: "consumed" },
    long: { "target-directory": "dir", suffix: "consumed", backup: "attached" },
    links: true,
  },
  unlink: {},
  // `-i` is `attached` so that BOTH spellings of in-place parse: BSD wants a
  // separate suffix (`sed -i '' 's/a/b/' f`), GNU forbids one
  // (`sed -i 's/a/b/' f`). Modelling `-i` as taking no separate value, plus
  // dropping empty operands, makes both land on `files: ["f"]`.
  sed: {
    short: { e: "consumed", f: "consumed", l: "consumed", i: "attached" },
    long: {
      expression: "consumed",
      file: "consumed",
      "line-length": "consumed",
      "in-place": "attached",
    },
    leading: { suppressedBy: ["e", "f", "expression", "file"] },
  },
  perl: {
    short: {
      e: "consumed",
      E: "consumed",
      I: "consumed",
      i: "attached",
      m: "attached",
      M: "attached",
      F: "attached",
      l: "attached",
      x: "attached",
      0: "attached",
      D: "attached",
    },
    leading: { suppressedBy: ["e", "E"] },
  },
  awk: {
    short: { f: "consumed", v: "consumed", F: "consumed", e: "consumed" },
    long: {
      file: "consumed",
      assign: "consumed",
      "field-separator": "consumed",
      source: "consumed",
    },
    leading: { suppressedBy: ["f", "e", "file", "source"] },
  },
  // git's leading operand is its subcommand, and nothing suppresses it.
  //
  // `--git-dir` and `--work-tree` are destinations, not settings: they name the
  // repository a mutating subcommand actually changes, exactly as `-C` does. A
  // `git --git-dir=<main>/.git commit` reaches the main checkout without ever
  // naming it as an operand, so reading them as plain consumed values left that
  // spelling unpoliced.
  git: {
    short: { C: "dir", c: "consumed" },
    long: {
      "git-dir": "dir",
      "work-tree": "dir",
      namespace: "consumed",
      "exec-path": "attached",
    },
    leading: {},
  },
} satisfies Record<string, CommandGrammar>;

export type KnownCommand = keyof typeof COMMAND_GRAMMAR;

/**
 * GNU coreutils installed under a `g` prefix (homebrew's default on macOS).
 * Same binaries, same grammar — and today they are policed by nothing at all.
 */
const ALIASES = {
  gsed: "sed",
  gawk: "awk",
  gcp: "cp",
  gmv: "mv",
  gln: "ln",
  grm: "rm",
  gmkdir: "mkdir",
  gchmod: "chmod",
  gchown: "chown",
  gtruncate: "truncate",
  ginstall: "install",
  gtouch: "touch",
  gshred: "shred",
} satisfies Record<string, KnownCommand>;

/**
 * The grammar entry a command name resolves to, following `g*` aliases.
 * `undefined` means "no entry" — a name nobody modelled, not a failure.
 */
export function canonicalCommand(name: string): KnownCommand | undefined {
  if (Object.hasOwn(COMMAND_GRAMMAR, name)) return name as KnownCommand;
  if (Object.hasOwn(ALIASES, name))
    return ALIASES[name as keyof typeof ALIASES];
  return undefined;
}

/** Today's behaviour for an unmodelled command: `-`-leading is a flag. */
const DEFAULT_GRAMMAR: CommandGrammar = {};

function grammarFor(name: string): CommandGrammar {
  const canonical = canonicalCommand(name);
  return canonical ? COMMAND_GRAMMAR[canonical] : DEFAULT_GRAMMAR;
}

/**
 * rsync's own heuristic for a remote spec: a `:` before the first `/`. It is
 * what keeps `./x:y` a local file while `host:/p` is not.
 */
const REMOTE_SPEC = /^[^:/]+:/;

function toOperand(
  raw: string,
  cwd: string,
  remoteSpecs: boolean,
): FileOperand {
  if (remoteSpecs && REMOTE_SPEC.test(raw)) return { kind: "remote", raw };
  return { kind: "local", raw, path: resolve(cwd, raw) };
}

export function parseArgv(call: ShellCall): ParsedArgv {
  const grammar = grammarFor(call.name);
  const remoteSpecs = grammar.remoteSpecs === true;
  const files: FileOperand[] = [];
  const flags = new Set<string>();
  let targetDir: FileOperand | undefined;
  let leading: string | undefined;
  let leadingFilled = false;
  let endOfOptions = false;

  /**
   * The leading slot is still open: the grammar declares one, nothing has
   * filled it, and no flag that replaces it has appeared (`sed -e <script>`
   * supplies the script, so the next positional is a FILE).
   */
  const leadingOpen = (): boolean =>
    grammar.leading !== undefined &&
    !leadingFilled &&
    !(grammar.leading.suppressedBy ?? []).some((f) => flags.has(f));

  const addOperand = (raw: string): void => {
    // An empty string can never name a file (POSIX: open("") is ENOENT), and
    // `resolve(cwd, "")` is the working directory — so keeping empties would
    // silently make an empty operand MEAN the cwd. Dropping them here, before
    // the leading slot is considered, is also what lets BSD's separate empty
    // suffix (`sed -i '' …`) parse identically to GNU's `sed -i …`.
    if (raw === "") return;
    if (leadingOpen()) {
      leading = raw;
      leadingFilled = true;
      return;
    }
    files.push(toOperand(raw, call.cwd, remoteSpecs));
  };

  /** A flag's value: recorded as taken, and (for `dir`) as the destination. */
  const takeValue = (arity: FlagArity, value: string | undefined): void => {
    if (arity === "dir" && value !== undefined && value !== "") {
      targetDir = toOperand(value, call.cwd, remoteSpecs);
    }
  };

  const args = call.args;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;

    if (endOfOptions) {
      addOperand(tok);
      continue;
    }
    // `--` ends options: everything after is an operand, `-`-leading or not.
    // `rm -- -weird` deletes a file literally named `-weird`.
    if (tok === "--") {
      endOfOptions = true;
      continue;
    }
    // A bare `-` names stdin/stdout, never a file on disk.
    if (tok === "-") continue;

    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const arity = grammar.long?.[name];
      flags.add(name);
      if (eq !== -1) {
        // `--name=value` is self-contained whatever the arity.
        takeValue(arity ?? "attached", tok.slice(eq + 1));
        continue;
      }
      // GNU long options accept both spellings, so `chmod --reference r f` must
      // parse the same as `chmod --reference=r f`. Only `attached` refuses the
      // next token — its value is optional and must be glued.
      if (arity === "consumed" || arity === "dir") {
        const value = args[++i];
        takeValue(arity, value);
      }
      continue;
    }

    if (tok.startsWith("-")) {
      // chmod's symbolic mode (`-w`, `-rx`) looks exactly like a flag cluster.
      if (grammar.leadingPattern?.test(tok) && leadingOpen()) {
        leading = tok;
        leadingFilled = true;
        continue;
      }
      // Cluster walk (the `rg-replace.ts` idiom): letters are flags until one
      // takes a value, and the rest of the cluster is THAT flag's value.
      const cluster = tok.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const letter = cluster[j]!;
        const arity = grammar.short?.[letter];
        flags.add(letter);
        if (arity === "consumed" || arity === "dir") {
          const tail = cluster.slice(j + 1);
          takeValue(arity, tail !== "" ? tail : args[++i]);
          break;
        }
        if (arity === "attached") {
          // The glued value may be empty (`sed -i` vs `sed -i.bak`); either way
          // the flag never reaches for the next token.
          break;
        }
      }
      continue;
    }

    addOperand(tok);
  }

  return {
    files: grammar.links ? linkOperands(files, targetDir, call.cwd) : files,
    targetDir,
    leading,
    flags,
  };
}

/**
 * Re-shape a `links` grammar's operands (see `CommandGrammar.links`): the
 * targets become `link-target`, so no consumer can resolve or police them, and
 * the one operand that names where the link is created stays `local`.
 */
function linkOperands(
  operands: readonly FileOperand[],
  targetDir: FileOperand | undefined,
  cwd: string,
): FileOperand[] {
  const asTarget = (o: FileOperand): FileOperand => ({
    kind: "link-target",
    raw: o.raw,
  });
  if (targetDir) return operands.map(asTarget);
  const [only] = operands;
  if (operands.length === 1 && only) {
    const name = basename(only.raw);
    return [
      asTarget(only),
      { kind: "local", raw: name, path: resolve(cwd, name) },
    ];
  }
  return operands.map((o, i) => (i < operands.length - 1 ? asTarget(o) : o));
}

/**
 * The files a call's redirections open for writing, resolved against its cwd.
 * A redirection target is always a local path — there is no remote spelling —
 * and an empty target names nothing.
 *
 * Only the `file` arm reaches here. A `fd` one (`2>&1`, `>&-`) names a
 * descriptor, and the parser gives it no path to resolve.
 */
export function redirectionTargets(call: ShellCall): FileOperand[] {
  return call.redirections.flatMap((r) =>
    r.kind === "file" && r.path !== ""
      ? [
          {
            kind: "local" as const,
            raw: r.path,
            path: resolve(call.cwd, r.path),
          },
        ]
      : [],
  );
}
