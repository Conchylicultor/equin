import {
  asFsPath,
  asPluginId,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import { scanCssRefs, scanMarkdownRefs } from "./relative-refs";
import { lineIndex, PLUGINS_DIR } from "./resolve";
import type { RefRange } from "./types";

/**
 * A free-text mention of one of a KNOWN set of plugins, anywhere in a text file:
 * a comment, a message, a test fixture, a constant, prose.
 *  - `path` — `plugins/a/plugins/b` (also inside `@plugins/…`, and followed by
 *    anything: `/web/x.ts`, `/CLAUDE.md`, a child's `/plugins/c`). `value` is
 *    the target's plugin dir; what follows it is outside the range.
 *  - `fs-path` — the same path without its leading `plugins/`
 *    (`a/plugins/b`, the form a registry lookup like `serverEntryFor(…)` takes,
 *    and a descendant's `a/plugins/b/plugins/c`). A top-level target's own fs
 *    path is a bare word, so it counts only when a descendant follows it
 *    (`a/plugins/b` for target `a`). `value` is the target's fs path.
 *  - `dot` — the dot id `a.b` (or a descendant's `a.b.c`), for targets whose id
 *    has a dot; a top-level id is a bare word and has no free-text spelling.
 *    `value` is the target's id.
 *
 * Unlike a `PluginRef`, a mention is only ever looked for by NAME — the caller
 * says which plugins — so a fixture's fake `plugins/a/web` is never one, and no
 * check resolves mentions: it asks whether a name that should be gone is still
 * written somewhere.
 */
export interface PluginMention {
  file: string;
  form: "path" | "fs-path" | "dot";
  /** The target that is mentioned (one of the ids asked for). */
  id: PluginId;
  range: RefRange;
  line: number;
  value: string;
}

const READ_WINDOW = 256;

// A path segment character, and the two boundaries a mention must sit between:
// nothing path-like before it (`x/plugins/a` is another dir's child, `./` and
// `../` make it relative), nothing that extends its last segment after it.
const SEG = "A-Za-z0-9_\\-";
const BEFORE_PATH = `(?<![${SEG}./])`;
const BEFORE_DOT = `(?<![${SEG}./@])`;
const AFTER = `(?![${SEG}])`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest first, so a target nested in another target wins its own text. */
const byLengthDesc = (a: string, b: string) => b.length - a.length;

/**
 * Every mention of `ids` (or of any of their descendants) in the repo's text
 * files, in file order. A file holding a NUL byte is binary and skipped. A
 * mention inside a markdown/CSS relative link's target is not one — that is a `relative` ref,
 * resolved against its file (`](plugins/x/CLAUDE.md)` inside a plugin names its
 * own child, not `plugins/x`).
 *
 * Nothing is excluded by policy: derived files, research records and the move
 * ledger are all scanned, and each consumer drops what it does not own.
 */
export async function findPluginMentions(
  repo: RepoFiles,
  ids: readonly PluginId[],
): Promise<PluginMention[]> {
  if (ids.length === 0) return [];
  const scan = mentionScanner(ids);
  const files = repo.all();
  const slice = createTimeSlicer();
  const out: PluginMention[] = [];
  for (let i = 0; i < files.length; i += READ_WINDOW) {
    const window = files.slice(i, i + READ_WINDOW);
    const texts = await Promise.all(window.map((f) => repo.read(f)));
    for (let k = 0; k < window.length; k++) {
      await slice();
      const text = texts[k];
      if (text != null) out.push(...scan(window[k]!, text));
    }
  }
  return out;
}

/**
 * The per-file half of `findPluginMentions`: a scanner for the mentions of
 * `ids` in one file's text (none in a binary one), in offset order.
 */
export function mentionScanner(
  ids: readonly PluginId[],
): (file: string, text: string) => PluginMention[] {
  const byPath = new Map(
    ids.map((id) => [`${PLUGINS_DIR}/${asFsPath(id)}`, id]),
  );
  // A nested id's fs path holds `/plugins/`, so it reads as a plugin path on
  // its own; a top-level one is a word until `/plugins/<child>` follows it.
  // `BEFORE_PATH` leaves the `plugins/<fs path>` spelling to the path form.
  const byFsPath = new Map(ids.map((id) => [asFsPath(id), id]));
  const dotted = ids.filter((id) => id.includes("."));
  const topLevel = ids.filter((id) => !id.includes("."));
  const alternation = (names: Iterable<string>) =>
    [...names].sort(byLengthDesc).map(escape).join("|");
  const pathRe = new RegExp(
    `${BEFORE_PATH}(?:${alternation(byPath.keys())})${AFTER}`,
    "g",
  );
  const fsPathAlternatives = [
    ...(dotted.length > 0
      ? [`(?:${alternation(dotted.map(asFsPath))})${AFTER}`]
      : []),
    ...(topLevel.length > 0
      ? [`(?:${alternation(topLevel)})(?=/${PLUGINS_DIR}/[${SEG}])`]
      : []),
  ];
  const fsPathRe = new RegExp(
    `${BEFORE_PATH}(?:${fsPathAlternatives.join("|")})`,
    "g",
  );
  const dotRe =
    dotted.length > 0
      ? new RegExp(`${BEFORE_DOT}(?:${alternation(dotted)})${AFTER}`, "g")
      : null;
  const needles = [`${PLUGINS_DIR}/`, ...dotted];

  return (file, text) => {
    if (!needles.some((n) => text.includes(n))) return [];
    if (text.includes("\u0000")) return [];
    const relative = file.endsWith(".md")
      ? scanMarkdownRefs(file, text)
      : file.endsWith(".css")
        ? scanCssRefs(file, text)
        : [];
    const inRelative = (at: number) =>
      relative.some((r) => at >= r.range.start && at < r.range.end);
    const lineOf = lineIndex(text);
    const out: PluginMention[] = [];
    const collect = (re: RegExp, form: PluginMention["form"]) => {
      for (const m of text.matchAll(re)) {
        if (inRelative(m.index)) continue;
        out.push({
          file,
          form,
          id:
            form === "path"
              ? byPath.get(m[0])!
              : form === "fs-path"
                ? byFsPath.get(m[0])!
                : asPluginId(m[0]),
          range: { start: m.index, end: m.index + m[0].length },
          line: lineOf(m.index),
          value: m[0],
        });
      }
    };
    collect(pathRe, "path");
    collect(fsPathRe, "fs-path");
    if (dotRe !== null) collect(dotRe, "dot");
    return out.sort((a, b) => a.range.start - b.range.start);
  };
}
