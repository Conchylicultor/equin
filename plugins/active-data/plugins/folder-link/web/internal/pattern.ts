/**
 * The SYNTACTIC gate for a backticked folder path: `~/Downloads/showcase/`,
 * `/tmp/out`, `plugins/apps/`.
 *
 * Shapes: rooted (`~/…` or `/…`, any depth) or relative with at least one
 * `/`. Segments are word characters plus `.@+-`, a leading dot allowed
 * (`~/.config/`); `..` and `./` are not paths an agent hands a reader.
 *
 * It must never full-match what `primitives/file-links`' `FILE_PATH_RE`
 * links as a FILE: the arbitration chain runs before the file-path inline
 * code handler, and a candidate that matches and then declines renders the
 * plain terminal — the file link would be lost. A file path's last segment
 * holds a dot or is a well-known extensionless name, so a folder path here
 * either ends in `/` or ends in a dotless segment that is not one of those
 * names. The overlap with the file-path test is pinned in `pattern.test.ts`.
 *
 * Syntactic only — `a/b` ("and/or") matches; the claim's stat says whether
 * the folder is real.
 */
const SEG = String.raw`\.?[\w@+-][\w.@+-]*`;
const LEAF = String.raw`[\w@+-]+`;
const EXTENSIONLESS_FILES =
  "Makefile|Dockerfile|Gemfile|Rakefile|Procfile|Brewfile";

export const FOLDER_PATH_RE = new RegExp(
  String.raw`^(?!(?:.*\/)?(?:${EXTENSIONLESS_FILES})$)(?=.*\w)(?:~?\/(?:${SEG}\/)*|(?:${SEG}\/)+)(?:${LEAF})?$`,
);
