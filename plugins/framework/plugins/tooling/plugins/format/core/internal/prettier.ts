// The repo's byte-format AUTHORITY: what may be formatted (the allowlist),
// with which options (the hardcoded object below), and which files must always
// be formatted together (the coupled sets). Everything that writes or asserts
// formatted bytes — `./singularity build`, `./singularity format`, and the
// `format-clean` check — goes through this one module, so the writer and the
// readers cannot produce different bytes.

import { extname } from "path";
import { FormatSyntaxError } from "./format-error";

/**
 * The allowlist. Nothing is formatted by default; a file type opts in HERE and
 * nowhere else.
 *
 * **Markdown must never be added** — prose reflows are review noise with no
 * mechanical benefit, and the docgen emitters would fight it. JSON/JSONC is
 * deliberately deferred.
 *
 * The allowlist is unbypassable by construction: the entry points take a file
 * path, have no `parser` parameter, and no content-only entry point exists — so
 * a caller cannot format a `.md` by asking nicely.
 */
export const FORMATTABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * Whether GENERATED artifacts (`*.generated.ts`) are formatted.
 *
 * Deliberately `false`, and deliberately ONE constant. Two writers reach
 * generated files — codegen's `formatGenerated` (which emits them) and the
 * changed-set format pass (which sees them as ordinary changed `.ts`) — and they
 * must agree. When they disagreed the result was a deterministic ping-pong:
 * codegen wrote the file unformatted, the build's format pass (which runs after
 * all codegen) reformatted it, so no build was ever idempotent and every
 * `*-in-sync` check over a generated file went red, since disk was formatted and
 * `formatGenerated({ file, content: renderX(...) })` was not.
 *
 * Flipping it is its own commit, on purpose. At prettier's default width
 * `web.generated.ts` goes from 783 to 10,150 lines (see the open decision in
 * `research/2026-08-06-global-prettier-auto-format.md`), so the flip is a
 * deliberate, isolated, revertible change — this one line, plus the reformatted
 * artifacts committed alongside it.
 */
const FORMAT_GENERATED_ARTIFACTS: boolean = false;

/** Every generated `.ts` artifact in the repo is named this way (18 today). */
const GENERATED_SUFFIX = ".generated.ts";

/**
 * Whether `file`'s bytes may be formatted at all: its extension is in
 * {@link FORMATTABLE_EXTENSIONS}, and it is not a generated artifact being held
 * out by {@link FORMAT_GENERATED_ARTIFACTS}.
 *
 * Both consumers read this one predicate — the format entry points (and
 * therefore codegen's `formatGenerated`) and the changed-set filter — so a
 * generated file cannot be formatted by one and not the other.
 *
 * Deliberately does NOT run {@link assertPathArg}: this is a filter predicate
 * over git-enumerated paths (`files.filter(isFormattable)`), `false` is a
 * legitimate answer for it, and making it throw would make that enumeration
 * non-total for no gain. The entry points assert; the predicate answers.
 */
export function isFormattable(file: string): boolean {
  const ext = extname(file).toLowerCase();
  if (!(FORMATTABLE_EXTENSIONS as readonly string[]).includes(ext))
    return false;
  if (!FORMAT_GENERATED_ARTIFACTS && file.endsWith(GENERATED_SUFFIX)) {
    return false;
  }
  return true;
}

/**
 * Files that must be formatted as a SET: touching one drags in all of them.
 *
 * Currently EMPTY, and that is the healthy state. Its one member was the six
 * `no-adhoc-*` class lint rules, which the former `class-token-walk-in-sync`
 * check asserted carried a byte-identical copy of the shared class-token walk:
 * formatting one of the six alone would have broken the byte-identity that check
 * defended, so they had to move together.
 *
 * There is now one walk, injected
 * (`tooling/plugins/lint/core/class-token-walk.ts`), so there are no copies to
 * hold identical and nothing couples those files any more. The mechanism stays
 * because the hazard is real for any future byte-compared set — a coupling that
 * exists but is not declared here shows up as a mystifying in-sync failure on a
 * branch that only ran a formatter.
 */
export const COUPLED_FORMAT_SETS: readonly (readonly string[])[] = [];

/**
 * The formatting options, HARDCODED rather than resolved.
 *
 * `prettier.resolveConfig()` is deliberately never called and `.prettierignore`
 * is deliberately not honored: the build (writer) and the in-sync checks
 * (readers) must emit byte-identical output, and a per-file config walk is a
 * way for them to diverge. The root `.prettierrc` exists only so editors agree
 * with this object.
 *
 * Every value is prettier's own default, spelled out so a prettier upgrade that
 * changes a default cannot silently reformat the repo. Measured line-length p90
 * across the repo is 80, so `printWidth: 80` is also the smallest possible
 * migration diff.
 */
const PRETTIER_OPTIONS = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  jsxSingleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: "always",
  endOfLine: "lf",
  singleAttributePerLine: false,
} as const;

/**
 * Memoized DYNAMIC import of prettier.
 *
 * Dynamic is load-bearing, not style. A static `import "prettier"` hoists above
 * every statement in the module graph, so a static import reachable from the
 * CLI would resolve out of the very `node_modules` that `ensureDeps()` exists
 * to repair — the same hazard `cli:bootstrap-package-free` enforces against on
 * `bin/index.ts`. Lazy also means a build whose changed set has no `.ts` pays
 * nothing.
 */
let mod: Promise<typeof import("prettier")> | null = null;
function prettier(): Promise<typeof import("prettier")> {
  return (mod ??= import("prettier"));
}

/**
 * The bytes of one file, for the two entry points below.
 *
 * A single NAMED object, never two positional strings, and that is the whole
 * point of the shape. `formatSource(source, file)` used to type-check and
 * silently return the PATH (see {@link assertPathArg}); with named fields there
 * is no adjacent slip left to make — producing the bug now requires naming both
 * fields wrongly, which is a lie rather than a typo.
 *
 * The bytes are `content`, not `source`, because ONE name per concept and this
 * seam's file set is `.md` / `.jsonc` / `.css` as much as it is `.ts`.
 */
export interface SourceBytes {
  file: string;
  content: string;
}

/** A path longer than this is not a path; POSIX `PATH_MAX` is 4096 on Linux. */
const MAX_PATH_LENGTH = 4096;

/**
 * Refuse a `file` argument that cannot be a path, naming the swap.
 *
 * This is the rung that matters for how the damage actually happened: an ad-hoc
 * script, run outside `tsc`, where the named-argument shape is a convention
 * rather than a constraint. On 2026-08-17 such a script called
 * `formatSource(src, file)`, got the path back as "formatted source", wrote it,
 * and destroyed 44 files with no error of any kind. Real source text has
 * newlines, so a swapped call now dies before anything can be returned.
 *
 * The not-formattable throw in {@link formatSource} catches the same swap from
 * typed code. This closes the residual case where a blob of source text happens
 * to end in something `extname` reads as an allowlisted extension.
 */
function assertPathArg(fn: string, file: string): void {
  if (file === "") throw new Error(`${fn}: "file" is empty.`);
  if (/[\n\r\0]/.test(file)) {
    throw new Error(
      `${fn}: "file" is not a path — it contains a newline or NUL. ` +
        `Arguments swapped? The shape is { file, content }.`,
    );
  }
  if (file.length > MAX_PATH_LENGTH) {
    throw new Error(
      `${fn}: "file" is ${file.length} chars, longer than any path. ` +
        `Arguments swapped? The shape is { file, content }.`,
    );
  }
}

/**
 * Format `content` as if it lived at `file`. Pure — never reads, never writes.
 *
 * THROWS when `file` is not formattable, rather than returning the input. The
 * two conditions "this file type is held out" and "the caller handed me
 * garbage" must not come back as the same value: when they did, a swapped-
 * argument call was indistinguishable from a legitimate pass-through and the
 * failure was totally silent. A caller whose file set legitimately contains
 * held-out paths says so by calling {@link formatIfFormattable} instead.
 *
 * A prettier failure (syntax error) THROWS too, re-stamped with the path so the
 * `line:col` prettier reports is attributable. Never swallow it: a silently
 * skipped file lands unformatted and `format-clean` then fails at push with no
 * explanation.
 */
export async function formatSource({
  file,
  content,
}: SourceBytes): Promise<string> {
  assertPathArg("formatSource", file);
  if (!isFormattable(file)) {
    throw new Error(
      `formatSource: "${file}" is not a formattable path ` +
        `(allowlist: ${FORMATTABLE_EXTENSIONS.join(", ")}` +
        `${FORMAT_GENERATED_ARTIFACTS ? "" : `; ${GENERATED_SUFFIX} held out`}). ` +
        `Use formatIfFormattable if a non-formattable file in your set is expected.`,
    );
  }
  const { format } = await prettier();
  try {
    // `parser` is pinned; `filepath` is what enables JSX for `.tsx`.
    return await format(content, {
      ...PRETTIER_OPTIONS,
      filepath: file,
      parser: "typescript",
    });
  } catch (err) {
    throw new FormatSyntaxError(
      `prettier failed to format ${file}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * {@link formatSource} for a caller whose file set legitimately contains paths
 * the allowlist holds out: returns `content` UNCHANGED for those, without even
 * loading prettier.
 *
 * The pass-through is load-bearing, which is why it has a name of its own
 * rather than living inside `formatSource` where it doubled as the swallow
 * path. Its ONE caller is codegen's `formatGenerated`, which routes every
 * generated artifact through this funnel with no per-emitter opt-in — and those
 * are `.md` (docgen, plugin `CLAUDE.md`), `.jsonc` (config origins, authored
 * overrides), `app.css`, and the `*.generated.ts` artifacts held out by
 * {@link FORMAT_GENERATED_ARTIFACTS}.
 */
export async function formatIfFormattable(bytes: SourceBytes): Promise<string> {
  assertPathArg("formatIfFormattable", bytes.file);
  if (!isFormattable(bytes.file)) return bytes.content;
  return await formatSource(bytes);
}
