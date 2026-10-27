// The one way to name a file inside a file root. A RelPath is a path RELATIVE
// to its root, validated segment by segment when it is made — so no absolute
// path, no `..` escape and no separator smuggled inside a segment has a
// spelling the store can be handed. `""` is the root itself.

declare const relPathBrand: unique symbol;

/** A validated path inside a file root: `/`-joined segments, `""` for the root. */
export type RelPath = string & { readonly [relPathBrand]: true };

/** A segment, or a whole path, that cannot name a file inside a root. */
export class InvalidRelPathError extends Error {
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(
      `Invalid path inside a file root ${JSON.stringify(input)}: ${reason}`,
    );
    this.name = "InvalidRelPathError";
  }
}

/** Why `segment` cannot be one segment of a RelPath, or `null` when it can. */
function segmentProblem(segment: string): string | null {
  if (segment === "") return "an empty segment";
  if (segment === "." || segment === "..") return `a "${segment}" segment`;
  if (segment.includes("/")) return "a segment containing '/'";
  if (segment.includes("\\")) return "a segment containing '\\'";
  if (segment.includes("\0")) return "a segment containing NUL";
  return null;
}

function checkedSegment(segment: string, input: string): string {
  const problem = segmentProblem(segment);
  if (problem !== null) throw new InvalidRelPathError(input, problem);
  return segment;
}

// The root of a file root.
const ROOT_PATH = "" as RelPath;

/**
 * A RelPath from its segments — each ONE name (`relPath("_picks", "x.json")`).
 * No arguments is the root. Throws {@link InvalidRelPathError} on an empty
 * segment, `.`, `..`, a `/` or `\` inside a segment, or NUL.
 */
export function relPath(...segments: string[]): RelPath {
  const input = segments.join("/");
  return segments.map((s) => checkedSegment(s, input)).join("/") as RelPath;
}

/**
 * A RelPath from a `/`-separated string (`"_picks/x.json"`); `""` is the root.
 * A leading or trailing `/`, `//`, and every segment {@link relPath} refuses
 * throw {@link InvalidRelPathError}. Decode before parsing: `%2e%2e` decoded is
 * `..`, which this refuses.
 */
export function parseRelPath(path: string): RelPath {
  if (path === "") return ROOT_PATH;
  if (path.startsWith("/"))
    throw new InvalidRelPathError(path, "an absolute path");
  return path
    .split("/")
    .map((s) => checkedSegment(s, path))
    .join("/") as RelPath;
}

/** `base` with `segments` appended, each validated like {@link relPath}. */
export function joinRel(base: RelPath, ...segments: string[]): RelPath {
  const tail = relPath(...segments);
  if (base === "") return tail;
  if (tail === "") return base;
  return `${base}/${tail}` as RelPath;
}

/** The segments of `path` (none for the root). */
export function splitRel(path: RelPath): readonly string[] {
  return path === "" ? [] : path.split("/");
}

/** The last segment of `path`. Throws for the root, which has no name. */
export function relName(path: RelPath): string {
  if (path === "") throw new InvalidRelPathError(path, "the root has no name");
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The directory holding `path`. Throws for the root, which has no parent. */
export function relParent(path: RelPath): RelPath {
  if (path === "")
    throw new InvalidRelPathError(path, "the root has no parent");
  const i = path.lastIndexOf("/");
  return (i === -1 ? "" : path.slice(0, i)) as RelPath;
}

/** Whether `path` is `dir` itself or somewhere below it. */
export function isWithinRel(path: RelPath, dir: RelPath): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}
