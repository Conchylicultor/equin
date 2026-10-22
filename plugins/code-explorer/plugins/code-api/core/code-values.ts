import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { CODE_MACHINE, CodeDirEntrySchema } from "./endpoints";

// A workspace's files as live values — each answering a question one of the
// deleted `/api/code/:worktree/*` GET routes used to answer — served by
// code-explorer's `machine/` half and notified
// while read: from a watch of the file's folder for a read of the file as it
// is on disk now, from the checkout watch (infra/git/checkout-watch: HEAD, the
// index, the own branch, `main`) for a read as of a named ref. A read pinned to
// shas only can never change, so it holds no watch. Plan:
// research/2026-10-11-global-endpoint-reads-onto-live.md (B6).
//
// `worktree` is the routes' workspace id: an attempt id of any workspace kind,
// `"main"`, `"self"`, or a checkout's absolute toplevel. `ref` is `HEAD`,
// `main` (read as `git merge-base main HEAD`) or a sha (7–40 hex).
//
// Refusals shared by every value (each declares the ones it can give):
// - `no-workspace` — `worktree` names no workspace (the routes' 404 "Not found");
// - `not-a-checkout` — a git read (a ref, a diff) of a workspace that is not a
//   git checkout (a scratch dir);
// - `invalid-path` — not a relative path inside the workspace (absolute, `~`,
//   escaping through `..`, empty, a NUL);
// - `invalid-ref` — a ref other than the three spellings above;
// - `missing` — nothing there (at that ref).

export const CodeFileSchema = z.object({ content: z.string() });
export type CodeFile = z.infer<typeof CodeFileSchema>;

/**
 * A workspace file as UTF-8 text — as it is on disk now (any workspace kind),
 * or AS OF `ref` (a checkout only): read on demand (up to 2 MiB, so each
 * tab reads it over HTTP, revalidated against the file's revision) and
 * invalidated while read. Also the content diff-view reads beside a diff (syntax tokens, expanded
 * context lines). Refused: `no-workspace`, `not-a-checkout`, `invalid-ref`,
 * `invalid-path`, `missing` (or not a file), `too-large`, `binary` (a NUL in
 * the first 8 KB), `denied`, `unreadable-archive`.
 */
export const codeFile = liveValue("code.file", {
  schema: CodeFileSchema,
  params: ["worktree", "path", "ref?"],
  load: "on-demand",
  refusals: [
    "no-workspace",
    "not-a-checkout",
    "invalid-ref",
    "invalid-path",
    "missing",
    "too-large",
    "binary",
    "denied",
    "unreadable-archive",
  ],
  needsMachine: CODE_MACHINE,
});

export const CodeFileDiffSchema = z.object({
  /** A unified diff; `""` when the file has no change. */
  diff: z.string(),
});
export type CodeFileDiff = z.infer<typeof CodeFileDiffSchema>;

/**
 * One file's unified diff in a checkout (the `diff` route it replaced is gone): the
 * working tree against `base` (default `HEAD`; `main` is the merge-base) when
 * `head` is absent, else `base..head` (`from` the old path of a rename). On
 * demand, invalidated while read by the checkout watch (the file itself, and
 * the git dir); a `base..head` of two shas holds no watch. Refused:
 * `no-workspace`, `not-a-checkout`, `invalid-path`, `invalid-ref`, `missing`
 * (an unchanged path that is not there), `too-large` (over 2 MiB).
 */
export const codeFileDiff = liveValue("code.file-diff", {
  schema: CodeFileDiffSchema,
  params: ["worktree", "path", "base?", "head?", "from?"],
  load: "on-demand",
  refusals: [
    "no-workspace",
    "not-a-checkout",
    "invalid-path",
    "invalid-ref",
    "missing",
    "too-large",
  ],
  needsMachine: CODE_MACHINE,
});

/** A listing's question: the folder (`""` is the root), as of `ref` when given. */
export const CodeDirQuerySchema = z.object({
  worktree: z.string(),
  dir: z.string(),
  ref: z.string().optional(),
});

export const CodeDirMetaSchema = z.object({
  /** How many entries the folder holds. */
  total: z.number(),
});

/**
 * One folder of a workspace, as a key-range-PAGED value (a folder grows with the user's data): its entries
 * by name in code-point order, 500 a page, at most 10 000 for a reader with
 * no viewport; the entry count is the meta sibling (`codeDir.meta`). On disk
 * now (any workspace kind; pushed from a watch of the folder's entries) or as
 * of `ref` (a checkout's tree; pushed from the checkout watch for a named
 * ref, never for a sha). Refused (pages and meta alike): `no-workspace`,
 * `not-a-checkout`, `invalid-path`, `invalid-ref`, `missing` (not a folder
 * there).
 */
export const codeDir = liveValue("code.dir", {
  query: CodeDirQuerySchema,
  paged: {
    item: CodeDirEntrySchema,
    id: "name",
    key: { of: (entry) => [entry.name], order: ["asc"] },
    limit: 500,
    maxLimit: 10_000,
    meta: CodeDirMetaSchema,
  },
  refusals: [
    "no-workspace",
    "not-a-checkout",
    "invalid-path",
    "invalid-ref",
    "missing",
  ],
  needsMachine: CODE_MACHINE,
});
