import { z } from "zod";
import { protoIdKind } from "./id";
import { mocksProblemDetail, parseMocks } from "./mocks";
import { parseViewport, viewportProblemDetail } from "./viewport";
import { readPrototypeEntry, type PrototypeEntry } from "./option-source";
import { foldOptions } from "./options";

// The rules that make a folder a prototype, as one pure function.
//
// A prototype is one folder holding a self-contained `index.html`: opening that
// file straight off disk (`file://`, no server) must render it, and nothing is
// shared between prototypes, so an agent starting a new one inherits no design.
//
// Most of that invariant is about *taste* and cannot be machine-checked. What
// CAN be checked is the file-level half — that a folder is shaped the way the
// server serves it, and that it reaches outside itself for nothing.
//
// Two callers, one rule set. Prototypes themselves are user content living in
// `~/.equin/apps/prototypes/`, so their problems surface in the gallery, on the
// card, where the author is looking. The `_template/` seed IS code, ships in the
// repo, and is checked by `prototypes:self-contained` at push time.

/** One thing wrong with a prototype folder. */
export const PrototypeProblemSchema = z.object({
  /** Path relative to the folder (`index.html`, `assets/`); `""` = the folder. */
  path: z.string(),
  detail: z.string(),
});
export type PrototypeProblem = z.infer<typeof PrototypeProblemSchema>;

/** `index.html` — the one required file, and the one the server serves. */
export const PROTOTYPE_ENTRY_FILE = "index.html";

/** File kinds worth scanning for cross-folder references (source, not bytes). */
const TEXT_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".md",
  ".txt",
  ".svg",
]);

/** Is this file worth reading as text (⇒ scannable for outward references)? */
export function isScannableFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  return TEXT_EXTENSIONS.has(
    dot === -1 ? "" : fileName.slice(dot).toLowerCase(),
  );
}

/** What one folder on disk looks like, read by the caller. */
export interface PrototypeFolder {
  /** The directory slug. */
  dirName: string;
  /** Subdirectory names directly inside it (dot-dirs already dropped). */
  subdirs: string[];
  /** File names directly inside it (dot-files already dropped). */
  files: string[];
  /** Text of every scannable file, keyed by file name. */
  texts: Map<string, string>;
  /** The other prototype folder names this one must not reach into. */
  siblings: string[];
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `text` reference the folder `name`?
 *
 * Matched at a *path position* — the name followed by `/`, not preceded by a
 * name character — so `href="helix/styles.css"` and `../helix/x` are caught
 * while a class named `.theme-helix` is not. A bare word match would flag every
 * prototype whose directory name is also an ordinary English word.
 */
function referencesFolder(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeForRegex(name)}/`).test(text);
}

/** A name made of name characters only — every minted id. */
const NAME_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * Every maximal run of name characters directly followed by `/` in `text` —
 * the names {@link referencesFolder} would match, all of them in one linear
 * pass. For a name of name characters only, `referencesFolder(text, name)` ⇔
 * `pathTokens(text).has(name)`: the match is preceded by a non-name character
 * (or the start) and followed by `/`, so it IS the maximal run before that `/`.
 *
 * One pass per file instead of one regex per sibling: a tree of N prototypes
 * scanned N times over is quadratic (130 prototypes, 11 MB of text: ~0.9 s of
 * a ~1 s gallery list).
 */
function pathTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (
    let slash = text.indexOf("/");
    slash !== -1;
    slash = text.indexOf("/", slash + 1)
  ) {
    let start = slash;
    while (start > 0 && isNameChar(text.charCodeAt(start - 1))) start -= 1;
    if (start === slash) continue;
    const token = text.slice(start, slash);
    if (!tokens.has(token)) tokens.add(ownCopy(token));
  }
  return tokens;
}

/**
 * `s` as a string of its own. A slice may share its parent's buffer (JSC's
 * substrings do), so a token kept in a `PrototypeScan` would pin the whole
 * file's text: measured over the gallery's 11.7 MB, 7.9 MB of heap kept by
 * ~4,300 tokens, against 0.4 MB copied.
 */
function ownCopy(s: string): string {
  return s.split("").join("");
}

/** `[A-Za-z0-9_-]`, by char code — {@link pathTokens}' inner loop. */
function isNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95
  );
}

/**
 * What one folder's validation needs of the folder alone — everything but
 * WHICH other prototypes exist. A long-lived lister (the server's) keeps one
 * per folder and re-reads a folder only when ITS files move: a prototype minted
 * or removed elsewhere changes no folder's bytes, only the sibling names its
 * references are judged against ({@link problemsOf}).
 *
 * `files` holds every file in validation order, each with its own problems and
 * its path tokens; a file's sibling references are joined in right after its
 * own problems, so the order matches a whole-folder validation exactly.
 */
export interface PrototypeScan {
  dirName: string;
  /** The folder-level problems: its name, subdirs, a missing entry file. */
  folderProblems: PrototypeProblem[];
  files: ScannedFile[];
  /**
   * What `index.html` declares about itself ({@link readPrototypeEntry}), read
   * in the same pass the validation made — so a lister takes the title, the
   * meta and the options from here instead of tokenizing the page again.
   * `undefined` when the folder has no readable entry file.
   */
  entry: PrototypeEntry | undefined;
  /**
   * The non-token names (not every character a name character — never a
   * minted id) the references were judged against, in order: such a name is
   * matched with the text in hand (`referencesFolder`), so a scan answers
   * only for the names it was given. A lister rescans when the set moves.
   */
  nonTokenNames: readonly string[];
}

interface ScannedFile {
  name: string;
  problems: PrototypeProblem[];
  /** {@link pathTokens} of its text — every token-shaped name it references. */
  tokens: ReadonlySet<string>;
  /** The {@link PrototypeScan.nonTokenNames} it references. */
  nonTokenRefs: ReadonlySet<string>;
}

/** The names among `names` a token lookup cannot answer (see {@link PrototypeScan.nonTokenNames}). */
export function nonTokenNamesOf(names: readonly string[]): string[] {
  return names.filter((name) => !NAME_TOKEN.test(name));
}

/** Every way `folder` fails the contract. Empty ⇒ it is a well-formed prototype. */
export function validatePrototypeFolder(
  folder: PrototypeFolder,
): PrototypeProblem[] {
  return problemsOf(
    scanPrototypeFolder(folder, nonTokenNamesOf(folder.siblings)),
    folder.siblings,
  );
}

/**
 * The scan's problems with the references into `siblings` joined in — what
 * {@link validatePrototypeFolder} answers for the same folder and siblings.
 * Linear in the folder's files times its siblings, reading no text.
 */
export function problemsOf(
  scan: PrototypeScan,
  siblings: readonly string[],
): PrototypeProblem[] {
  const problems = [...scan.folderProblems];
  for (const file of scan.files) {
    problems.push(...file.problems);
    for (const sibling of siblings) {
      if (sibling === scan.dirName) continue;
      const referenced = NAME_TOKEN.test(sibling)
        ? file.tokens.has(sibling)
        : file.nonTokenRefs.has(sibling);
      if (referenced) {
        problems.push({
          path: file.name,
          detail: siblingReferenceDetail(sibling),
        });
      }
    }
  }
  return problems;
}

/**
 * How a reference to another prototype's folder is worded. A minted id is
 * written bare — no quoting, no trailing `/` — so every surface that shows a
 * problem through the inline-text walkers (the canvas's problem banner) draws
 * it as the prototype id chip: its title, opening that prototype. A hand-made
 * folder name is no id and stays quoted.
 */
function siblingReferenceDetail(sibling: string): string {
  return protoIdKind.is(sibling)
    ? `references another prototype's folder, ${sibling}`
    : `references another prototype's folder (\`${sibling}/\`)`;
}

/**
 * The sibling-independent half of {@link validatePrototypeFolder}: every rule
 * but "references another prototype's folder", plus what that rule needs of
 * each file's text. `nonTokenNames` are the non-token sibling names to judge
 * against ({@link nonTokenNamesOf}); token-shaped names are answered later
 * from the tokens, whatever they are.
 */
export function scanPrototypeFolder(
  folder: Omit<PrototypeFolder, "siblings">,
  nonTokenNames: readonly string[],
): PrototypeScan {
  const folderProblems: PrototypeProblem[] = [];

  // A folder whose name is not a minted id. Skips `_`-prefixed directories:
  // `_template` is a seed rather than a prototype, and the repo check runs this
  // same function over it — an unguarded rule would fail every push.
  //
  // Deliberately a PROBLEM, not a refusal. Prototypes are user content, so a
  // hand-made folder keeps being listed and served; what it loses is the ability
  // to be referenced — nothing can write `ember` in a message and have it
  // resolve. This is the loud-runtime rung, and it is what stops
  // `cp -R _template <name>` from being silently fine again.
  if (!folder.dirName.startsWith("_") && !protoIdKind.is(folder.dirName)) {
    folderProblems.push({
      path: "",
      detail:
        "the folder name is not a minted prototype id (proto-<epoch>-<4 chars>), so this prototype cannot be referenced by id from a conversation — create prototypes with `./equin prototype new` instead of copying _template by hand",
    });
  }

  for (const sub of [...folder.subdirs].sort()) {
    folderProblems.push({
      path: `${sub}/`,
      detail:
        "a prototype folder is flat — the route matches one path segment and has no wildcard, so nothing under a subdirectory can be served",
    });
  }

  if (!folder.files.includes(PROTOTYPE_ENTRY_FILE)) {
    folderProblems.push({
      path: PROTOTYPE_ENTRY_FILE,
      detail: "missing — index.html is the one required file",
    });
  }
  if (folder.files.includes("meta.json")) {
    folderProblems.push({
      path: "meta.json",
      detail:
        "leftover — metadata now comes from index.html (title, meta description, meta prototype-viewport)",
    });
  }

  const files: ScannedFile[] = [];
  let entry: PrototypeEntry | undefined;
  for (const fileName of [...folder.files].sort()) {
    const text = folder.texts.get(fileName);
    if (text === undefined) continue;
    const problems: PrototypeProblem[] = [];

    if (fileName === PROTOTYPE_ENTRY_FILE) {
      const facts = readPrototypeEntry(text);
      entry = facts;
      if ((facts.title ?? "").trim() === "") {
        problems.push({
          path: fileName,
          detail:
            'no non-empty <title> — the gallery card, the pane header and every chip would read "Untitled prototype" instead of a name',
        });
      }
      if (facts.loadsExternalBabelScript) {
        problems.push({
          path: fileName,
          detail:
            'loads a Babel script from a separate file (<script type="text/babel" src="…">) — Babel fetches src with XHR, which Chrome blocks over file://, so the page renders nothing when opened from Finder. Inline the JSX instead',
        });
      }
      // A `mocks` line that is not a `<kind>:<ref>` declaration. Absent is the
      // ordinary case and never a problem; a mistyped line is, because the
      // Compare stage would otherwise have to explain it on its own, one stage
      // away from where the author is looking.
      const mocks = parseMocks(facts.mocks ?? "");
      if (mocks.kind === "malformed") {
        problems.push({ path: fileName, detail: mocksProblemDetail(mocks) });
      }
      // A size that is not a preset name, `window` or `responsive` (the retired
      // `WxH` form included): the canvas opens it at This window, so say why here.
      const viewport = parseViewport(facts.viewport);
      if (!viewport.ok) {
        problems.push({
          path: fileName,
          detail: viewportProblemDetail(viewport.raw),
        });
      }
      // Every `prototype-option` line that cannot be an option: it is left out
      // of the app's picker, so the card is where the author learns why.
      for (const detail of foldOptions(facts.optionSource).problems) {
        problems.push({ path: fileName, detail });
      }
    }

    if (text.includes("_shared")) {
      problems.push({
        path: fileName,
        detail: "references _shared, which no longer exists",
      });
    }
    if (text.includes("../")) {
      problems.push({
        path: fileName,
        detail: "references `../`, which reaches outside the folder",
      });
    }
    files.push({
      name: fileName,
      problems,
      tokens: pathTokens(text),
      nonTokenRefs: new Set(
        nonTokenNames.filter((name) => referencesFolder(text, name)),
      ),
    });
  }

  return {
    dirName: folder.dirName,
    folderProblems,
    files,
    entry,
    nonTokenNames: [...nonTokenNames],
  };
}
