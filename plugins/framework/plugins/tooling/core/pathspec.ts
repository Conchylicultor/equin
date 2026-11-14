// Queries over a sorted path list: a directory's subtree (`pathsUnder`) and
// pathspec globs (`globPaths`) — the ONE matcher both the plain repo
// set (`repoFilesOver`) and the check runner's tree snapshot (`read-set.ts`)
// answer `glob(pattern)` with, so a check's recorded glob fact replays to the
// same answer the check was given.

/**
 * First index in `sorted` whose path is `>= key`, comparing UTF-16 code units
 * — the order `Array.prototype.sort()` produces, which every path source uses.
 */
function lowerBound(sorted: readonly string[], key: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Every path in `sorted` under directory `dir` (no trailing slash; "" = all of
 * it), recursive, in order, as a fresh array. `sorted` must be in
 * `Array.prototype.sort()` order. Two binary searches and a slice — never a
 * scan of the list.
 *
 * In a lexicographically sorted list a directory's files are one contiguous
 * run, `[dir + "/", dir + "0")`: "0" is the code unit right after "/", so a
 * path sorts inside that range iff it starts with `dir/`.
 */
export function pathsUnder(sorted: readonly string[], dir: string): string[] {
  if (dir === "") return sorted.slice();
  return sorted.slice(
    lowerBound(sorted, `${dir}/`),
    lowerBound(sorted, `${dir}0`),
  );
}

// `<dir>/**`: a literal directory — no glob magic, no leading `:` pathspec
// magic — followed by `/**`. The subtree form `ctx.repo().under(dir)` records;
// see `globPaths`.
const SUBTREE_GLOB = /^([^:*?[][^*?[]*)\/\*\*$/;

/**
 * Strip a leading git pathspec magic signature so the glob body is left to
 * translate. Long form `:(glob)` / `:(glob,icase)` / `:(top)…`; the trailing `)`
 * closes the group. Short form (`:!`, `:^`) is an EXCLUDE pathspec — not stripped
 * here (no flipped check uses one), so it degrades to the literal-prefix branch,
 * which over-matches (safe). Returns `{ body, glob }` where `glob` is true when
 * the `:(glob)` magic was present (so `*` must NOT span `/`); we ignore that and
 * always let `*` span `/` because OVER-matching is the safe direction.
 */
function stripPathspecMagic(pathspec: string): string {
  if (pathspec.startsWith(":(")) {
    const close = pathspec.indexOf(")");
    if (close >= 0) return pathspec.slice(close + 1);
  }
  return pathspec;
}

/**
 * Translate a git pathspec into a SUPERSET-SAFE regex. Erring toward
 * OVER-matching is the load-bearing invariant: an over-broad match set only
 * causes an unnecessary re-check, never a missed invalidation (a stale PASS).
 * This regex feeds `pathspecFingerprint` — the H9 new-matcher guard — so it MUST
 * be a superset of the true `git grep -l … -- <pathspec>` file set, or a brand-
 * new matching file could slip past unrecorded.
 *
 * Handles: leading git magic (`:(glob)…`, stripped first), `**` and `*` (both
 * mapped to `.*`, spanning `/` — a superset of git-glob's `*` which does not),
 * a double-star followed by a slash (the trailing slash is folded into the `.*`
 * so zero intermediate segments still match — `plugins/[**]/x.ts` matches
 * `plugins/x.ts`), `?` → `.`, and `[…]` char classes. A magic-free pathspec
 * matches itself OR anything under it (git's dir-prefix default).
 */
export function pathspecToRegex(pathspec: string): RegExp {
  const body = stripPathspecMagic(pathspec);
  const hasMagic = /[*?[]/.test(body);
  if (hasMagic) {
    let out = "";
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch === "*") {
        // `**` → `.*` and CONSUME a following `/` so zero intermediate segments
        // still match (superset). A single `*` → `.*` (spans `/`, a superset of
        // git-glob semantics — safe).
        if (body[i + 1] === "*") {
          out += ".*";
          i++;
          if (body[i + 1] === "/") i++;
        } else {
          out += ".*";
        }
      } else if (ch === "?") out += ".";
      else if (ch === "[") {
        const end = body.indexOf("]", i);
        if (end < 0) {
          out += "\\[";
        } else {
          out += body.slice(i, end + 1);
          i = end;
        }
      } else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    return new RegExp(`^${out}$`);
  }
  // No magic: a plain path matches itself OR anything under it (dir prefix).
  const dir = body.replace(/\/+$/, "");
  const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}(/.*)?$`);
}

/**
 * Every path in `sorted` (`Array.prototype.sort()` order) matching `pattern`,
 * a git pathspec read SUPERSET-SAFE (see `pathspecToRegex`): a caller that needs
 * an exact set filters the answer.
 *
 * `**` and `<dir>/**` — what `RepoFiles.all()` / `.under(dir)` record — are one
 * contiguous run of the sorted list: two binary searches instead of a regex
 * over every path. Same answer as the regex, except for a path holding a line
 * terminator, which the regex's `.` never matches and the range includes — the
 * superset side.
 */
export function globPaths(
  sorted: readonly string[],
  pattern: string,
): string[] {
  const subtree = pattern === "**" ? "" : SUBTREE_GLOB.exec(pattern)?.[1];
  if (subtree !== undefined) return pathsUnder(sorted, subtree);
  const re = pathspecToRegex(pattern);
  return sorted.filter((p) => re.test(p));
}
