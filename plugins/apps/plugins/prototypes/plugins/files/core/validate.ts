import { z } from "zod";
import { scanHtml } from "@plugins/infra/plugins/html-decode/core";
import { protoIdKind } from "./id";
import { mocksProblemDetail, parseMocks } from "./mocks";
import { parseViewport, viewportProblemDetail } from "./viewport";
import { readPrototypeOptions } from "./option-source";

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
    if (start < slash) tokens.add(text.slice(start, slash));
  }
  return tokens;
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

/** What the validator reads off `index.html`, gathered in one scan. */
interface EntryFacts {
  /** A non-empty `<title>` — same reading `list-metas.ts` makes. */
  hasTitle: boolean;
  /**
   * It loads a Babel-transformed script from a separate file.
   *
   * `<script type="text/babel" src="app.jsx">` is the one violation that LOOKS
   * fine: it works perfectly through the server, and silently renders nothing
   * over `file://`. Babel-standalone fetches a `src` with XHR, and Chrome
   * refuses file→file XHR, so the double-click invariant dies while every HTTP
   * check stays green. JSX therefore goes INLINE, in a `<script
   * type="text/babel">` with no `src`. (A plain non-Babel `<script
   * src="fixtures.js">` is fine — that's an ordinary script load, not XHR.)
   */
  loadsExternalBabelScript: boolean;
  /**
   * The decoded `content` of the first `<meta name="mocks">` /
   * `<meta name="prototype-viewport">`, `undefined` when absent. Same scanner
   * and first-occurrence rule as `list-metas.ts`; the judgement itself is the
   * tag's own parser (`parseMocks`, `parseViewport`), so the validator and the
   * reader can never disagree about what a line means.
   */
  mocks: string | undefined;
  viewport: string | undefined;
}

/**
 * Read {@link EntryFacts} off `index.html` in ONE pass of the scanner — the
 * entry file is most of a tree's bytes (5 MB of a gallery's 11), and the
 * gallery re-validates it on every list.
 */
function readEntryFacts(html: string): EntryFacts {
  let title: string | undefined;
  let loadsExternalBabelScript = false;
  let mocks: string | undefined;
  let viewport: string | undefined;
  scanHtml(html, {
    elements: {
      script(el) {
        if (el.attr("type")?.trim().toLowerCase() !== "text/babel") return;
        if (el.attr("src") !== undefined) loadsExternalBabelScript = true;
      },
      meta(el) {
        const name = el.attr("name");
        if (name === "mocks") mocks ??= el.attr("content");
        else if (name === "prototype-viewport") viewport ??= el.attr("content");
      },
    },
    text: {
      title(text) {
        title ??= text;
      },
    },
  });
  return {
    hasTitle: (title ?? "").trim() !== "",
    loadsExternalBabelScript,
    mocks,
    viewport,
  };
}

/** Every way `folder` fails the contract. Empty ⇒ it is a well-formed prototype. */
export function validatePrototypeFolder(
  folder: PrototypeFolder,
): PrototypeProblem[] {
  const problems: PrototypeProblem[] = [];

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
    problems.push({
      path: "",
      detail:
        "the folder name is not a minted prototype id (proto-<epoch>-<4 chars>), so this prototype cannot be referenced by id from a conversation — create prototypes with `./equin prototype new` instead of copying _template by hand",
    });
  }

  for (const sub of [...folder.subdirs].sort()) {
    problems.push({
      path: `${sub}/`,
      detail:
        "a prototype folder is flat — the route matches one path segment and has no wildcard, so nothing under a subdirectory can be served",
    });
  }

  if (!folder.files.includes(PROTOTYPE_ENTRY_FILE)) {
    problems.push({
      path: PROTOTYPE_ENTRY_FILE,
      detail: "missing — index.html is the one required file",
    });
  }
  if (folder.files.includes("meta.json")) {
    problems.push({
      path: "meta.json",
      detail:
        "leftover — metadata now comes from index.html (title, meta description, meta prototype-viewport)",
    });
  }

  for (const fileName of [...folder.files].sort()) {
    const text = folder.texts.get(fileName);
    if (text === undefined) continue;

    if (fileName === PROTOTYPE_ENTRY_FILE) {
      const facts = readEntryFacts(text);
      if (!facts.hasTitle) {
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
      for (const detail of readPrototypeOptions(text).problems) {
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
    const tokens = pathTokens(text);
    for (const sibling of folder.siblings) {
      if (sibling === folder.dirName) continue;
      const referenced = NAME_TOKEN.test(sibling)
        ? tokens.has(sibling)
        : referencesFolder(text, sibling);
      if (referenced) {
        problems.push({
          path: fileName,
          detail: `references another prototype's folder (\`${sibling}/\`)`,
        });
      }
    }
  }

  return problems;
}
