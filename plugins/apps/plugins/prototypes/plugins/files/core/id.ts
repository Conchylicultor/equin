import { defineIdKind } from "@plugins/ids/core";

// THE one declaration of a prototype's id — the mint, the folder-name
// validation (`protoIdKind.is`), the chip's inline recognition and
// `prototypeIdsIn` all read it from here (`plugins/ids`).
//
// A prototype's id IS its directory name, so the filesystem is the uniqueness
// authority and the mint is a `mkdir` (`machine/internal/mint.ts` re-mints on a
// collision): there is no dir↔id map in front of the routes, the watcher, the
// thumbnail cache or the backup source. It is opaque rather than a slug because
// the folder is minted BEFORE the agent has designed anything — any name chosen
// at that moment is a guess, and renaming later would change the id, which is
// the one thing an id exists to prevent. Nothing is lost to a human: every
// surface that displays a prototype reads `meta.title` out of its `<title>`.
//
// The mint is the `stamped` shape (`proto-<epochSeconds>-<6 base36>`); folders
// minted before it carry a 4-char suffix and stay valid, because recognition is
// the generic body every kind shares, not the current mint's exact shape.
//
// `core/` is browser-importable, so this module stays dependency-free.

/** The prototype id kind: `protoIdKind.mint()`, `protoIdKind.is(folderName)`. */
export const protoIdKind = defineIdKind({
  prefix: "proto",
  label: "Prototype",
});

// Word-guarded on both sides: `proto-1790000000-abcd123xy` holds no id — the
// suffix is variable-length (4–8), so the guard stops it backtracking to one.
// `matchAll` clones the regex, so this shared `g` instance keeps no state
// across calls.
const MENTIONED_ID_RE = new RegExp(
  `(?<![A-Za-z0-9])(?:${protoIdKind.pattern.source})(?![A-Za-z0-9])`,
  "g",
);

// Walked leaf by leaf rather than matched against `JSON.stringify(value)`: the
// escapes it writes (`\n`, `\t`) would put a letter right before an id that
// starts a line of a Bash command, and the guard above would then reject it.
function* stringLeaves(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringLeaves(item);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* stringLeaves(item);
  }
}

/**
 * Every prototype id named anywhere in an already-parsed value — a string, or
 * any JSON shape whose string leaves are walked — first mention first, deduped.
 *
 * The scan, not just the shape: two consumers ask the same question of the same
 * kind of payload (a tool call's `input`). The end-of-turn checkpoint job asks
 * it of a finished turn's calls to decide which prototypes to record; the
 * transcript's artifacts surface asks it of the calls on screen. Re-deriving the
 * word guard and the leaf walk per consumer is the `att-`/`block-` failure this
 * module exists to avoid — a change to the mint would switch one of them off
 * with nothing failing.
 *
 * An id that is not a prototype on disk is not filtered here: this reads a
 * mention, and whether the folder exists is the caller's question.
 */
export function prototypeIdsIn(value: unknown): string[] {
  const ids = new Set<string>();
  for (const text of stringLeaves(value)) {
    for (const match of text.matchAll(MENTIONED_ID_RE)) ids.add(match[0]);
  }
  return [...ids];
}

/**
 * What a prototype is called when its `index.html` has no `<title>`.
 *
 * The lister used to fall back to the directory name, which read fine while
 * that was a slug (`ember`) and reads as nothing at all now that it is a minted
 * id. It lives beside the id rather than in the lister because the reason it
 * exists is the id's opacity, and because the surfaces that display a title —
 * the gallery card, the pane header, the chip — must agree on the answer; the
 * chip in particular cannot be left to spot the fallback and relabel it, which
 * is a per-surface patch on a single-source problem.
 *
 * It is also the `<title>` the blank template ships, so a freshly minted
 * prototype reads the same before its first save as one whose title was
 * deleted.
 */
export const UNTITLED_PROTOTYPE = "Untitled prototype";
