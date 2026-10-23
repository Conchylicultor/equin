import { resolve } from "node:path";
import { CLI_NAME, isCliName } from "@plugins/framework/plugins/cli/core";

export interface ShellCall {
  /**
   * The command's basename — except the repo CLI, which is always `CLI_NAME`
   * whichever of its names was typed (`./equin`, `./equin`), so a guard
   * matching it cannot miss the other spelling.
   */
  name: string;
  args: string[];
  raw: string;
  /**
   * Effective working directory when this call runs, folding every preceding
   * `cd` in the chain over `baseCwd`. Resolve a call's relative path args
   * against THIS — never treat them as literal strings, or `cd <dir> && rm
   * <rel>` slips past. Equals `baseCwd` when no `baseCwd` was supplied.
   */
  cwd: string;
  /**
   * Output redirections local to this sub-command. Resolve the `path` of a
   * `kind: "file"` one against `cwd`; the others name no file at all.
   */
  redirections: ShellRedirection[];
  /**
   * True when this call reads the previous pipeline stage's output on stdin —
   * the `tail` of `cmd | tail`, the `head` of `cmd |& head`. A wrapper and
   * the command it wraps (`cmd | timeout 5 tail`) both carry it; a call nested
   * in a `$( … )` or a loop body inside that stage does not.
   */
  pipedIn: boolean;
}

/**
 * One OUTPUT redirection.
 *
 * The two arms are the whole point: `2>&1` duplicates a file descriptor and
 * `>&-` closes one — neither names a path, and resolving the word after the
 * operator as if it did is what falsely blocked every read-only command run
 * with a cwd in the main checkout. A consumer must narrow on `kind` before it
 * can reach a path, so that mistake no longer compiles.
 *
 * INPUT redirections (`<`, `<<`, `<<<`, `<&`) never surface here: they write
 * nothing, and left in the token stream they pose as positional args — which
 * made `c` the destination of `cp a b < c`.
 *
 * The left-hand fd is deliberately absent: `2>log` and `>log` write the same
 * file, and no consumer has ever needed to tell them apart.
 */
export type ShellRedirection =
  | { kind: "file"; op: ">" | ">>"; path: string }
  | { kind: "fd"; op: ">" | ">>"; toFd: string };

export interface ShellParseResult {
  calls: ShellCall[];
  /** Every redirection across the command, flattened from `calls`. */
  redirections: ShellRedirection[];
  /**
   * The text the shell would actually EXECUTE: the input with every heredoc body
   * — and the `<<DELIM` operator introducing it — removed.
   *
   * A guard that must regex raw command text reads THIS, never `input.command`,
   * or a document being WRITTEN reads as a command being RUN. A body an
   * interpreter executes (`bash <<EOF`) is not re-inserted here; its commands
   * still surface in `calls`.
   */
  code: string;
}

type Mode = "none" | "single" | "double";

/**
 * Finds the first shell call in a (possibly compound) command that satisfies
 * `predicate`, scanning EVERY call — not just the first invocation of a binary.
 *
 * The predicate MUST encode the full danger condition (the command name AND its
 * offending args together). Never match by name here and re-check the args back
 * at the call site: a benign earlier call (`rg -n …; rg -rn …`, or
 * `find . -maxdepth 1 …; find /huge …`) would mask a dangerous later one because
 * the first name-match short-circuits. Folding the whole condition into a single
 * predicate makes that class of bug structurally impossible — which is why every
 * Bash guard routes call selection through here.
 *
 * Pass `baseCwd` whenever the predicate resolves a path. Without it each call's
 * `cwd` is `""`, and `resolve("", rel)` quietly falls back to the guard
 * PROCESS's own directory — an answer that happens to be right today and has no
 * reason to stay right.
 */
export function findCall(
  cmd: string,
  predicate: (call: ShellCall) => boolean,
  baseCwd = "",
): ShellCall | undefined {
  return parseShell(cmd, baseCwd).calls.find(predicate);
}

export function parseShell(cmd: string, baseCwd = ""): ShellParseResult {
  const calls: ShellCall[] = [];
  const { code } = collect(cmd, baseCwd, calls, 0);
  return { calls, redirections: calls.flatMap((c) => c.redirections), code };
}

/** Guards against a pathological nesting depth in hand-written input. */
const MAX_DEPTH = 8;

/**
 * Walk one command string, appending a `ShellCall` per simple command found —
 * INCLUDING the ones nested inside loop bodies, `if` branches, command
 * substitutions and subshells.
 *
 * Reaching inside those is the whole point. `splitOnOperators` alone yields a
 * flat token stream in which `until X; do git push; done` becomes a call
 * literally *named* `do` carrying `["git", "push"]` as its args — so every
 * predicate of the shape `c.name === "git" && c.args[0] === "push"` silently
 * fails to match, and the guard that owns it may as well not exist. The same
 * held for `$(…)`, backticks and `( … )` groups. Any construct a shell executes
 * must produce a call here, or it becomes a blind spot every Bash guard shares.
 *
 * Returns the cwd in effect after the last segment, and the executable text this
 * scope parsed (its input minus every heredoc body). Inner scopes get the
 * enclosing cwd and their return value is discarded on purpose: a `cd` inside a
 * subshell or a `$( … )` does not move the parent shell's directory.
 *
 * The heredoc pre-pass runs HERE rather than once in `parseShell`, so every
 * context this function parses is heredoc-modelled — the top-level string, a
 * `$( … )` body, a backtick body, a `( … )` group. `splitOnOperators` splits on
 * newlines, so any body that survives into it is read line-by-line as commands,
 * which is the whole bug this models away.
 */
function collect(
  cmd: string,
  baseCwd: string,
  out: ShellCall[],
  depth: number,
): { cwd: string; code: string } {
  if (depth > MAX_DEPTH) return { cwd: baseCwd, code: cmd };
  const { code, docs } = splitHeredocs(cmd);
  let cwd = baseCwd;
  /** One entry per segment, so a heredoc body can be attributed to its owner. */
  const segs: Segment[] = [];
  let pipedIn = false;
  for (const part of splitOnOperators(code)) {
    const from = out.length;
    const segCwd = cwd;
    const seg = part.text.trim();
    if (seg) cwd = collectSegment(seg, cwd, out, depth, pipedIn);
    pipedIn = isPipe(part.sep);
    segs.push({
      end: part.end,
      sep: part.sep,
      from,
      to: out.length,
      cwd: segCwd,
    });
  }
  for (const doc of docs) attachDoc(doc, segs, out, baseCwd, depth);
  return { cwd, code };
}

/** A segment of a compound command, plus the span of `out` it contributed. */
interface Segment {
  /** Offset in `code` just past this segment's text (its separator's index). */
  end: number;
  /** The operator that ended this segment (`""` for the last one). */
  sep: string;
  from: number;
  to: number;
  /** The cwd in effect BEFORE this segment's own `cd`. */
  cwd: string;
}

/** A separator that hands the left side's stdout to the right side's stdin. */
function isPipe(sep: string): boolean {
  return sep === "|" || sep === "|&";
}

/** Emit the calls of one already-split segment; returns the cwd after it. */
function collectSegment(
  seg: string,
  cwd: string,
  out: ShellCall[],
  depth: number,
  pipedIn: boolean,
): string {
  // Pull `$( … )` / backtick bodies out FIRST, so their contents are parsed as
  // commands rather than swallowed as opaque argument text — and so the
  // prefix peel below cannot mistake a substitution body for a command. In
  // `x=$(cd /tmp && pwd)` the assignment's value spans a space, so peeling on
  // whitespace before extraction would strand `/tmp && pwd)` as the command.
  const { stripped, inner } = extractSubstitutions(seg);
  const head = peelPrefixes(stripped);

  // A whole `( … )` group is its own shell: parse it in an isolated scope so
  // a `cd` inside cannot move the parent's directory.
  if (head.startsWith("(") && matchParen(head, 0) === head.length - 1) {
    collect(head.slice(1, -1), cwd, out, depth + 1);
    for (const src of inner) collect(src, cwd, out, depth + 1);
    return cwd;
  }

  let cur = cwd;
  // Words and redirections come out of ONE walk of the text. Deriving them
  // separately — a regex over a quote-masked copy for the redirections, another
  // over the quote-erased tokens for the args — is what let the two disagree:
  // a quoted `> "<path>"` vanished from both, and `&>file` survived as an arg.
  const { words, redirections } = splitCommand(head);
  const tokens = stripGroupParens(words);
  // A wrapper (`nohup`, `env`, `sudo`, `xargs`, `timeout`, …) carries the real
  // command in its args, hiding it from every name-matching predicate the same
  // way a loop body did — `nohup git push` would otherwise walk past git-push.
  // Emit the wrapper AND what it wraps, peeling one layer at a time.
  for (let toks = tokens; toks.length > 0;) {
    const bin = basename(toks[0]!);
    const name = isCliName(bin) ? CLI_NAME : bin;
    const args = toks.slice(1);
    // The call runs in the cwd in effect BEFORE its own `cd` takes hold; a
    // `cd` only moves the directory for the calls that follow it.
    out.push({ name, args, raw: seg, cwd: cur, redirections, pipedIn });
    if (name === "cd") cur = applyCd(cur, args);
    if (!WRAPPERS.has(name)) break;
    const wrapped = dropWrapperOptions(args);
    if (wrapped.length === 0 || wrapped.length === toks.length) break;
    toks = wrapped;
  }

  for (const src of inner) collect(src, cur, out, depth + 1);
  return cur;
}

/** A heredoc operator seen on the current line, awaiting its body. */
interface PendingHeredoc {
  delim: string;
  expanded: boolean;
  strip: boolean;
  at: number;
}

/** One heredoc lifted out of a command by `splitHeredocs`. */
interface HeredocDoc {
  /** The body text, verbatim, minus the terminator line. */
  body: string;
  /** Unquoted delimiter: the shell expands `$( … )` / backticks inside the body. */
  expanded: boolean;
  /** Offset in `code` where the `<<DELIM` operator was removed. */
  at: number;
}

/**
 * A delimiter word, in the four spellings bash accepts. Anything else is left
 * alone — the grammar is what keeps `$((x << shift))` and stray `a << b` prose
 * from starting a "body" that swallows the rest of the command and blinds every
 * guard after it. Only the bare form expands the body.
 */
const HEREDOC_DELIM =
  /^(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)"|\\([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*))/;

/**
 * Binaries that read a script on stdin, so their heredoc body IS executed.
 *
 * `python3 - <<'PY'` and friends are deliberately absent: their bodies are not
 * shell, and pretending otherwise mints phantom calls out of another language's
 * source. That blind spot is the same one `python3 -c "…"` already has, and
 * making it consistent beats making it lucky.
 */
const SHELL_INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
]);

/**
 * Lift every heredoc body out of a command, leaving the text the shell actually
 * executes.
 *
 * A body is data handed to a process on stdin — never part of the token stream.
 * Left in place it is read as commands, because `splitOnOperators` splits on
 * newlines and `extractSubstitutions` lifts backticks: a markdown document
 * written by `cat > x.md <<'EOF'` then parses as a script, and every Bash guard
 * denies the write on a command nothing is running.
 *
 * The scanner tracks quoting AND substitution context, not quoting alone. The
 * commonest heredoc in this repo is
 *
 *     ./equin push -m "$(cat <<'EOF'   ← `<<` sits inside the `-m` quote
 *
 * where a quote-only mask declines. It is tempting to leave that to the
 * recursion — `splitOnOperators` keeps the whole `$( … )` in one segment, so the
 * body reaches `collect` again through `extractSubstitutions` and is stripped
 * there. That holds only while the body's `"` count is even: one unpaired quote
 * in the prose flips the mode back to `none` mid-body, and the remaining lines
 * split at depth 0 into phantom commands the recursion never sees. Entering a
 * `$( … )` restores the fresh quoting context the shell itself uses, so the body
 * is removed here — which also repairs the quote tracking downstream instead of
 * working around it.
 */
function splitHeredocs(text: string): { code: string; docs: HeredocDoc[] } {
  if (!text.includes("<<")) return { code: text, docs: [] };

  const docs: HeredocDoc[] = [];
  const pending: PendingHeredoc[] = [];
  let code = "";
  let mode: Mode = "none";
  /** Quoting modes suspended by an enclosing `$( … )` / `( … )` / backtick. */
  const frames: { mode: Mode; kind: "subst" | "paren" | "backtick" }[] = [];
  let i = 0;

  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === "\n") {
      code += c;
      i++;
      if (pending.length > 0) i = consumeBodies(text, i, pending, docs);
      continue;
    }

    if (mode === "single") {
      code += c;
      if (c === "'") mode = "none";
      i++;
      continue;
    }

    if (c === "\\" && next !== undefined) {
      code += c + next;
      i += 2;
      continue;
    }

    if (mode === "none") {
      if (c === "'") {
        mode = "single";
        code += c;
        i++;
        continue;
      }
      // A comment runs to end of line: `# see <<EOF for details` must not start
      // a body that eats the rest of the script.
      if (c === "#" && (code === "" || /[\s;|&(]$/.test(code))) {
        const nl = text.indexOf("\n", i);
        const end = nl === -1 ? text.length : nl;
        code += text.slice(i, end);
        i = end;
        continue;
      }
    }

    if (c === '"') {
      mode = mode === "double" ? "none" : "double";
      code += c;
      i++;
      continue;
    }

    // `$(( … ))` is arithmetic, not a command: copy it verbatim so `x << shift`
    // inside it can never be read as a heredoc.
    if (c === "$" && next === "(" && text[i + 2] === "(") {
      const end = matchParen(text, i + 1);
      if (end !== -1) {
        code += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    // A substitution starts a fresh quoting context, in `none` AND in `double`.
    if (c === "$" && next === "(") {
      frames.push({ mode, kind: "subst" });
      mode = "none";
      code += "$(";
      i += 2;
      continue;
    }
    if (c === "`") {
      const top = frames.at(-1);
      if (top?.kind === "backtick") {
        mode = top.mode;
        frames.pop();
      } else {
        frames.push({ mode, kind: "backtick" });
        mode = "none";
      }
      code += c;
      i++;
      continue;
    }
    if (mode === "none" && c === "(") {
      frames.push({ mode, kind: "paren" });
      code += c;
      i++;
      continue;
    }
    if (mode === "none" && c === ")") {
      const top = frames.at(-1);
      if (top && top.kind !== "backtick") {
        mode = top.mode;
        frames.pop();
      }
      code += c;
      i++;
      continue;
    }

    if (mode === "none" && c === "<" && next === "<") {
      // `<<<` is a here-string, not a heredoc. Stepping one char at a time would
      // land on the second `<`, read `<<` + a word, and swallow every following
      // line as a body — so consume all three at once.
      if (text[i + 2] === "<") {
        code += "<<<";
        i += 3;
        continue;
      }
      const doc = matchHeredocOperator(text, i);
      if (doc) {
        // Drop the operator's own text: the pre-pass knows its exact offsets,
        // where a token-level rule could not tell `<<EOF` from a quoted `"<<x>>"`
        // argument, the word reader having already erased the quotes.
        code = code.replace(/\d+$/, "");
        pending.push({ ...doc, at: code.length });
        i = doc.end;
        continue;
      }
    }

    code += c;
    i++;
  }

  // An unterminated heredoc: bash errors, but the body is still not a command.
  if (pending.length > 0) consumeBodies(text, i, pending, docs);
  return { code, docs };
}

/** Read one `\d*<<-?DELIM` operator at `i`, or null when it is not one. */
function matchHeredocOperator(
  text: string,
  i: number,
): (Omit<PendingHeredoc, "at"> & { end: number }) | null {
  let j = i + 2;
  const strip = text[j] === "-";
  if (strip) j++;
  while (text[j] === " " || text[j] === "\t") j++;
  const m = HEREDOC_DELIM.exec(text.slice(j));
  if (!m) return null;
  const delim = m[1] ?? m[2] ?? m[3] ?? m[4]!;
  return { delim, expanded: m[4] !== undefined, strip, end: j + m[0].length };
}

/**
 * Consume one body per pending operator, in the order the operators appeared,
 * and return the offset just past the last terminator.
 *
 * The terminator test is deliberately lax (`trim()`, where bash wants an exact
 * line): terminating earlier than the shell leaves text OUTSIDE the body, where
 * it is still parsed. Erring the other way would hide real commands.
 */
function consumeBodies(
  text: string,
  start: number,
  pending: PendingHeredoc[],
  docs: HeredocDoc[],
): number {
  let i = start;
  for (const p of pending) {
    const lines: string[] = [];
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      const line = nl === -1 ? text.slice(i) : text.slice(i, nl);
      i = nl === -1 ? text.length : nl + 1;
      const candidate = p.strip ? line.replace(/^\t+/, "") : line;
      if (candidate.trim() === p.delim) break;
      lines.push(line);
    }
    docs.push({ body: lines.join("\n"), expanded: p.expanded, at: p.at });
  }
  pending.length = 0;
  return i;
}

/**
 * Parse a heredoc body as far as the shell would, and no further.
 *
 * `bash <<'EOF'` executes its body whatever the delimiter quoting, and so does
 * `cat <<'EOF' … | bash` — without the pipeline arm this fix would hand every
 * Bash guard a one-line bypass. An unquoted delimiter expands substitutions but
 * runs nothing else. A quoted delimiter on a non-interpreter is inert data, the
 * 97% case, and contributes nothing.
 */
function attachDoc(
  doc: HeredocDoc,
  segs: Segment[],
  out: ShellCall[],
  baseCwd: string,
  depth: number,
): void {
  const i = segs.findIndex((s) => doc.at <= s.end);
  const owner = i === -1 ? segs.at(-1) : segs[i];
  // The body runs where its own segment runs: `cd sub && bash <<'EOF'` must not
  // resolve the body's paths against the parent directory.
  const cwd = owner?.cwd ?? baseCwd;
  const interpreter = (s: Segment | undefined) =>
    !!s && out.slice(s.from, s.to).some((c) => SHELL_INTERPRETERS.has(c.name));
  const piped =
    owner && isPipe(owner.sep) && i !== -1 ? segs[i + 1] : undefined;

  if (interpreter(owner) || interpreter(piped)) {
    collect(doc.body, cwd, out, depth + 1);
    return;
  }
  if (!doc.expanded) return;
  for (const src of bodySubstitutions(doc.body))
    collect(src, cwd, out, depth + 1);
}

/**
 * The `$( … )` / backtick sources inside an expanded heredoc body.
 *
 * Quote-BLIND on purpose: a body has no quoting, so `'` is a literal apostrophe
 * there. `extractSubstitutions` would let one open a phantom single-quoted region
 * and hide every substitution after it — `it's $(git push)` would parse to
 * nothing at all.
 */
function bodySubstitutions(body: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const next = body[i + 1];
    if (c === "\\" && next !== undefined) {
      i++;
      continue;
    }
    if (c === "$" && next === "(") {
      const end = matchParen(body, i + 1);
      if (end !== -1) {
        out.push(body.slice(i + 2, end));
        i = end;
        continue;
      }
    }
    if (c === "`") {
      const end = body.indexOf("`", i + 1);
      if (end !== -1) {
        out.push(body.slice(i + 1, end));
        i = end;
      }
    }
  }
  return out;
}

/**
 * Shell words that introduce a command rather than being one. Peeling them is
 * what turns `do git push` back into `git push`.
 */
const BLOCK_KEYWORDS = new Set([
  "until",
  "while",
  "if",
  "elif",
  "then",
  "else",
  "do",
  "done",
  "fi",
  "case",
  "esac",
  "select",
  "time",
  "!",
  "{",
  "}",
]);

/**
 * Binaries whose job is to run another command. The wrapped command must surface
 * as its own call, or wrapping becomes a way past every Bash guard.
 */
const WRAPPERS = new Set([
  "nohup",
  "setsid",
  "env",
  "sudo",
  "nice",
  "ionice",
  "stdbuf",
  "timeout",
  "xargs",
  "command",
  "exec",
  "time",
  "script",
  "caffeinate",
  "taskpolicy",
  "darwinbg",
  "watch",
]);

/**
 * Drop a wrapper's own flags and their values so the wrapped command is first:
 * `timeout 30 cmd`, `nice -n 5 cmd`, `env FOO=1 cmd` all reduce to `cmd`.
 */
function dropWrapperOptions(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      i++;
      continue;
    }
    // A bare duration/priority belongs to `timeout`/`nice`, not to the command.
    if (/^\d+(\.\d+)?[smhd]?$/.test(a)) {
      i++;
      continue;
    }
    break;
  }
  return args.slice(i);
}

/**
 * Strip leading block keywords and `VAR=value` prefixes off a segment until a
 * real command name is exposed. Returns "" when the segment holds no command.
 */
function peelPrefixes(seg: string): string {
  let s = seg;
  for (;;) {
    if (!s) return "";
    const sp = s.search(/\s/);
    const head = sp === -1 ? s : s.slice(0, sp);
    // `for f in a b` binds a variable over a word list — never a command.
    if (head === "for") return "";
    const isAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(head);
    if (!isAssignment && !BLOCK_KEYWORDS.has(head)) return s;
    s = sp === -1 ? "" : s.slice(sp + 1).trim();
  }
}

/**
 * Split a segment into the text outside command substitutions and the sources
 * inside them. Single-quoted regions are left alone — the shell does not expand
 * substitutions there, so neither do we.
 */
function extractSubstitutions(s: string): {
  stripped: string;
  inner: string[];
} {
  const inner: string[] = [];
  let stripped = "";
  let mode: Mode = "none";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const next = s[i + 1];
    if (mode === "single") {
      stripped += c;
      if (c === "'") mode = "none";
      continue;
    }
    if (c === "\\" && next !== undefined) {
      stripped += c + next;
      i++;
      continue;
    }
    if (mode === "none" && c === "'") {
      mode = "single";
      stripped += c;
      continue;
    }
    if (c === '"') {
      mode = mode === "double" ? "none" : "double";
      stripped += c;
      continue;
    }
    if (c === "$" && next === "(") {
      const end = matchParen(s, i + 1);
      if (end !== -1) {
        inner.push(s.slice(i + 2, end));
        i = end;
        continue;
      }
    }
    // `>(cmd)` / `<(cmd)` RUN a command and expand to a `/dev/fd/N` word.
    // Lifting the body here does three jobs at once: the inner command becomes a
    // real call (`tee >(sh -c "rm <main>/x")` was invisible to every guard), its
    // text can never be read as a redirection target, and it can never pose as
    // an arg.
    if (mode === "none" && (c === ">" || c === "<") && next === "(") {
      const end = matchParen(s, i + 1);
      if (end !== -1) {
        inner.push(s.slice(i + 2, end));
        i = end;
        continue;
      }
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end !== -1) {
        inner.push(s.slice(i + 1, end));
        i = end;
        continue;
      }
    }
    stripped += c;
  }
  return { stripped, inner };
}

/** Index of the `)` closing the `(` at `open`, or -1 when unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Drop the parentheses of a `( … )` group so its first word is read as the
 * command name. `splitOnOperators` is paren-blind, so a group containing an
 * operator arrives here already split (`(a && b)` → `(a`, `b)`) — hence leading
 * and trailing parens are handled independently, and the trailing one only when
 * this segment is actually unbalanced.
 */
function stripGroupParens(tokens: string[]): string[] {
  const out = tokens.slice();
  while (out.length > 0 && out[0]!.startsWith("(")) {
    const head = out[0]!.replace(/^\(+/, "");
    if (head) out[0] = head;
    else out.shift();
  }
  const joined = out.join(" ");
  const opens = (joined.match(/\(/g) ?? []).length;
  const closes = (joined.match(/\)/g) ?? []).length;
  if (closes > opens && out.length > 0) {
    const last = out.length - 1;
    const tail = out[last]!.replace(/\)+$/, "");
    if (tail) out[last] = tail;
    else out.pop();
  }
  return out;
}

/** Fold a single `cd` over the running cwd. */
function applyCd(cwd: string, args: string[]): string {
  const target = args.find((a) => !a.startsWith("-"));
  // `cd` / `cd -` / `cd ~…` resolve to dirs we can't know here; leave the cwd
  // unchanged rather than guess. Absolute targets replace it; relative ones
  // fold onto it.
  if (!target || target === "-" || target.startsWith("~")) return cwd;
  return resolve(cwd, target);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * One part of a compound command, carrying its span so a heredoc body recorded
 * by the pre-pass can be attributed to the part that owns it — its cwd, and
 * whether it is piped into a shell.
 */
interface ShellPart {
  text: string;
  /** Offset in the input just past this part (its separator's index). */
  end: number;
  /** The operator that ended this part (`""` for the last one). */
  sep: string;
}

function splitOnOperators(s: string): ShellPart[] {
  const parts: ShellPart[] = [];
  let cur = "";
  let mode: Mode = "none";
  // Depth of `(` … `)` — covers both subshells and `$( … )`. Operators inside a
  // group are the GROUP's, not ours: splitting there would tear a substitution
  // body apart before `extractSubstitutions` ever sees it, and would strand a
  // subshell's `cd` in the parent scope.
  let depth = 0;
  let inBacktick = false;
  /**
   * The last character emitted OUTSIDE quotes, which is how a redirection's own
   * `&`/`|` is told from a separator. Reading `s[i - 1]` instead would let a
   * quoted or escaped `>` (`echo "x>" | tail`) absorb the pipe and swallow the
   * rest of the command into a single segment.
   */
  let prev = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (mode === "none") {
      if (c === "'") {
        mode = "single";
        cur += c;
        prev = "";
        continue;
      }
      if (c === '"') {
        mode = "double";
        cur += c;
        prev = "";
        continue;
      }

      if (c === "\\" && next !== undefined) {
        cur += c + next;
        prev = "";
        i++;
        continue;
      }
      if (c === "`") {
        inBacktick = !inBacktick;
        cur += c;
        prev = "";
        continue;
      }
      if (c === "(") {
        depth++;
        cur += c;
        prev = c;
        continue;
      }
      if (c === ")") {
        if (depth > 0) depth--;
        cur += c;
        prev = c;
        continue;
      }
      if (depth > 0 || inBacktick) {
        cur += c;
        prev = c!;
        continue;
      }
      // `2>&1` / `&>file` / `>|file`: the `&` or `|` belongs to the redirection,
      // not to us. Splitting on the `|` of `>|` lost the redirection outright and
      // minted a phantom call named after the file — a write to main nothing saw.
      if (
        (c === "&" || c === "|") &&
        (prev === ">" || (c === "&" && next === ">"))
      ) {
        cur += c;
        prev = c;
        continue;
      }
      // `|&` is ONE operator (a pipe carrying stderr too). Split as `|` then `&`
      // it would leave an empty segment between the two sides, and the right
      // side would no longer read as piped into.
      if (
        (c === "&" && next === "&") ||
        (c === "|" && (next === "|" || next === "&"))
      ) {
        parts.push({ text: cur, end: i, sep: c + next });
        cur = "";
        prev = "";
        i++;
        continue;
      }
      // Newlines are command separators too — a multi-line script must split
      // into one call per line, or a dangerous call on line 2+ would collapse
      // into line 1's token stream and lose its name/cwd attribution. A line
      // continuation (`\<newline>`) is consumed by the `\\` escape branch above,
      // so it never reaches here and correctly does NOT split.
      if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r") {
        parts.push({ text: cur, end: i, sep: c });
        cur = "";
        prev = "";
        continue;
      }
      cur += c;
      prev = c!;
    } else if (mode === "single") {
      cur += c;
      prev = "";
      if (c === "'") mode = "none";
    } else {
      if (c === "\\" && next !== undefined) {
        cur += c + next;
        i++;
        continue;
      }
      cur += c;
      prev = "";
      if (c === '"') mode = "none";
    }
  }
  if (cur) parts.push({ text: cur, end: s.length, sep: "" });
  return parts;
}

/**
 * A word that is really the left-hand fd of the redirection glued to it (`2>f`,
 * `{fd}>f`) — never an argument.
 */
const FD_PREFIX = /^(?:\d+|\{[A-Za-z_]\w*\})$/;

/** The words naming a file descriptor rather than a file: `1`, `2-`, `-`. */
const FD_WORD = /^(?:\d+-?|-)$/;

/**
 * A redirection operator: the text it spans, and whether it writes.
 *
 * A `writes: false` (input) operator still consumes its word. That word is not
 * an argument, and leaving it in the token stream is what made `c` the
 * destination of `cp a b < c`.
 */
type RedirOp =
  | { len: number; writes: true; op: ">" | ">>"; dup: boolean }
  | { len: number; writes: false };

/** The redirection operator at `i`, or null when there is none. */
function matchRedirOp(s: string, i: number): RedirOp | null {
  const at = (t: string) => s.startsWith(t, i);
  // `>(cmd)` / `<(cmd)` is a process substitution: a command that expands to a
  // `/dev/fd/N` word, never a redirection. `extractSubstitutions` lifts it before
  // we get here; this covers a nesting it declined to lift.
  if (at(">(") || at("<(")) return null;
  if (at("&>>")) return { len: 3, writes: true, op: ">>", dup: false };
  if (at("&>")) return { len: 2, writes: true, op: ">", dup: false };
  if (at(">>")) return { len: 2, writes: true, op: ">>", dup: false };
  // `>|` overrides noclobber — still a plain write to the word that follows.
  if (at(">|")) return { len: 2, writes: true, op: ">", dup: false };
  if (at(">&")) return { len: 2, writes: true, op: ">", dup: true };
  // `<>` opens for read AND write: err toward reporting the write.
  if (at("<>")) return { len: 2, writes: true, op: ">", dup: false };
  if (at(">")) return { len: 1, writes: true, op: ">", dup: false };
  if (at("<<<")) return { len: 3, writes: false };
  if (at("<<")) return { len: 2, writes: false };
  if (at("<&")) return { len: 2, writes: false };
  if (at("<")) return { len: 1, writes: false };
  return null;
}

/** One word read off a segment, plus where it ended. */
interface ShellWord {
  /** The word with its quotes removed, exactly as the shell would pass it on. */
  text: string;
  /** Any part of it was quoted or escaped, so `&1` there is a filename. */
  quoted: boolean;
  /** Offset just past the word. */
  end: number;
}

/**
 * Read one word starting at `i`, stopping at whitespace or at an UNQUOTED
 * redirection operator — `echo a>b` is the word `a` then a redirection, exactly
 * as bash reads it. Returns null when no word starts there.
 */
function readWord(s: string, i: number): ShellWord | null {
  let cur = "";
  let started = false;
  let quoted = false;
  let mode: Mode = "none";
  while (i < s.length) {
    const c = s[i]!;
    const next = s[i + 1];
    if (mode === "none") {
      if (/\s/.test(c)) break;
      if (matchRedirOp(s, i)) break;
      if (c === "'" || c === '"') {
        mode = c === "'" ? "single" : "double";
        started = true;
        quoted = true;
        i++;
        continue;
      }
      if (c === "\\" && next !== undefined) {
        cur += next;
        started = true;
        quoted = true;
        i += 2;
        continue;
      }
      cur += c;
      started = true;
      i++;
      continue;
    }
    if (mode === "single") {
      if (c === "'") mode = "none";
      else cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      mode = "none";
      i++;
      continue;
    }
    if (c === "\\" && next !== undefined) {
      cur += next;
      i += 2;
      continue;
    }
    cur += c;
    i++;
  }
  return started ? { text: cur, quoted, end: i } : null;
}

/**
 * Split one simple command into its words and its output redirections, in a
 * SINGLE quote-aware pass.
 *
 * One pass is the whole point. The words and the redirections used to be derived
 * separately — a regex over a copy with quoted regions masked out for the
 * redirections, another over the already-unquoted tokens for the words — and two
 * re-derivations of one grammar disagree. Every way they disagreed was a bug in
 * a guard: `2>&1` reported a write to a file named `&1`, `> "<path>"` reported no
 * redirection at all (a write to main nothing saw), and `&>file` survived as a
 * positional arg.
 *
 * The `&1` one was not a curiosity. Replaying 30 days of Bash calls, it
 * accounted for 55 of `main-writes`' 60 denials against 3 real ones — a guard
 * whose blocks are overwhelmingly noise is one agents learn to work around.
 *
 * `>&word` keeps its file when the word is not a descriptor: there it is bash's
 * synonym for `&>word`, which truncates that file and sends both streams into
 * it. Dropping every `&`-leading word would read `cmd >&out.txt` as writing
 * nothing.
 */
function splitCommand(s: string): {
  words: string[];
  redirections: ShellRedirection[];
} {
  const words: string[] = [];
  const redirections: ShellRedirection[] = [];
  // Inside `[[ … ]]`, `<` and `>` compare strings: reading them as redirections
  // minted a phantom path (`[[ "$a" > "$b" ]]` reported a write to `]]`).
  let comparison = false;
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i]!)) {
      i++;
      continue;
    }
    const op = comparison ? null : matchRedirOp(s, i);
    if (op) {
      // `> f` and `>f` are the same redirection: the blanks between an operator
      // and its word are not a word boundary the way they are between args.
      let at = i + op.len;
      while (s[at] === " " || s[at] === "\t") at++;
      const target = readWord(s, at);
      // A dangling operator: bash errors, and nothing is written anywhere.
      if (!target) break;
      i = target.end;
      if (!op.writes) continue;
      // `>&1` is a fd, `>&file` sends BOTH streams to that file: either way the
      // `&` belongs to the operator and is never part of a path.
      const amp = !target.quoted && target.text.startsWith("&");
      const word = amp ? target.text.slice(1) : target.text;
      if ((op.dup || amp) && !target.quoted && FD_WORD.test(word)) {
        redirections.push({ kind: "fd", op: op.op, toFd: word });
      } else {
        redirections.push({ kind: "file", op: op.op, path: word });
      }
      continue;
    }
    const word = readWord(s, i);
    if (!word) {
      i++;
      continue;
    }
    i = word.end;
    // A bare fd glued to an operator (`2>f`, `{fd}>f`) belongs to the operator.
    if (!word.quoted && FD_PREFIX.test(word.text) && matchRedirOp(s, i))
      continue;
    if (words.length === 0 && word.text === "[[") comparison = true;
    words.push(word.text);
  }
  return { words, redirections };
}
