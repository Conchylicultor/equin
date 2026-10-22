import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  HOST_FS_PEEK_MAX_NAMES,
  HostFsEntrySchema,
  HostFsWithinSchema,
  type HostFsArchiveReason,
} from "./endpoints";
import { HOST_FS_MACHINE } from "./machine-feature";

// The host filesystem as live values — each answering a question the old list /
// peek / stat / text / volume endpoints answered (reusing the result schemas in
// `./endpoints.ts`), with the failures they answered as result kinds turned
// into declared refusals (`error.kind === "refused"`, `error.code` typed),
// served by host-fs's `machine/` half and pushed from the shared dir hub while
// read. Plan: research/2026-10-11-global-endpoint-reads-onto-live.md (B5).

const MACHINE = HOST_FS_MACHINE;

// Why a host-fs read cannot answer, as the read's refusal code (each value
// declares the ones its read can give):
//
// - `invalid-path` — not absolute, not `~`-rooted, or holding a NUL byte;
// - `missing` — nothing there (ENOENT, or a component is not a folder);
// - `denied` — the user account may not read it (EACCES / EPERM);
// - `not-a-dir` / `not-a-file` — the wrong kind of entry for the read;
// - `unreadable-archive` — the path crosses into an archive that cannot be
//   read; the message says why (see `hostFsArchiveReasonMessage`).

/** The sentence an unreadable archive's refusal carries, by reason. */
export function hostFsArchiveReasonMessage(
  reason: HostFsArchiveReason,
): string {
  switch (reason) {
    case "corrupt":
      return "This archive is damaged or not in a format it claims";
    case "encrypted":
      return "This archive is encrypted";
    case "unsupported-method":
      return "This archive uses a compression method that cannot be read";
    case "too-many-entries":
      return "This archive has too many entries to browse";
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

/** A listing's question: the folder (absolute or `~`-rooted); none = home. */
export const HostFsListingQuerySchema = z.object({
  path: z.string().optional(),
});

/** What a listing says about its folder beside the entries — one per question. */
export const HostFsListingMetaSchema = z.object({
  /** The resolved absolute path (`~` expanded, `..` collapsed, no trailing slash). */
  path: z.string(),
  /** `null` at the filesystem root. */
  parent: z.string().nullable(),
  /** How many entries the folder holds, hidden ones included. */
  total: z.number(),
  /** Set when the folder lies inside an archive (see `HostFsWithinSchema`). */
  within: HostFsWithinSchema.optional(),
});
export type HostFsListingMeta = z.infer<typeof HostFsListingMetaSchema>;

/**
 * A host folder's entries — `list` as a key-range-PAGED value, since a folder
 * grows with the user's data: each page is a name range of entries, ordered by
 * name in CODE-POINT order (`"B" < "a"`, `"10" < "9"`: the order a page is cut
 * in — a surface that shows "as people sort" sorts what it holds). Read with
 * `useLive(hostFsListing, { path }, { limit })` (every page live, at most
 * `maxLimit` entries) or under a viewport (no depth limit); the folder's own
 * facts — resolved path, parent, total, `within` — are the meta sibling,
 * `useLive(hostFsListing.meta, { path })`.
 *
 * Pushed while read from a children-scope watch of the folder (a watch of the
 * archive file, inside one). An archive file lists its root; a symlink to a
 * folder lists its target. Refused (pages and meta alike): `invalid-path`,
 * `missing`, `denied`, `not-a-dir`, `unreadable-archive`.
 */
export const hostFsListing = liveValue("host-fs.list", {
  query: HostFsListingQuerySchema,
  paged: {
    item: HostFsEntrySchema,
    id: "name",
    key: { of: (entry) => [entry.name], order: ["asc"] },
    limit: 500,
    // A reader with no viewport holds at most this many entries of one
    // folder — the size past which `peek` stops naming children too.
    maxLimit: HOST_FS_PEEK_MAX_NAMES,
    meta: HostFsListingMetaSchema,
  },
  refusals: [
    "invalid-path",
    "missing",
    "denied",
    "not-a-dir",
    "unreadable-archive",
  ],
  needsMachine: MACHINE,
});

// ── peek ─────────────────────────────────────────────────────────────────────

/**
 * What a folder holds, by name only. Bounded: at most
 * {@link HOST_FS_PEEK_MAX_NAMES} names — a fuller folder answers `too-many`
 * with its raw total — so a peek is never a whole-folder payload.
 */
export const HostFsDirPeekSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    path: z.string(),
    /** Every child, hidden ones included, by name only — no child is stat'ed. */
    children: z.array(z.object({ name: z.string(), hidden: z.boolean() })),
  }),
  /** More than {@link HOST_FS_PEEK_MAX_NAMES} children: `total` counts them all. */
  z.object({
    kind: z.literal("too-many"),
    path: z.string(),
    total: z.number(),
  }),
  /**
   * An archive file on disk: a peek never opens one (reading its index is not
   * the cheap read a peek promises). Its listing lists its root.
   */
  z.object({ kind: z.literal("archive"), path: z.string() }),
]);
export type HostFsDirPeek = z.infer<typeof HostFsDirPeekSchema>;

/**
 * The child names of one host folder (`peek`): one `readdir` on disk, the
 * cached index inside an archive — for counting a folder's items without
 * listing it. Many folders at once: `useLive(hostFsDirPeek, paths.map((path)
 * => ({ path })))`. Pushed while read from a children-scope watch of the
 * folder. Refused: `invalid-path`, `missing`, `denied`, `not-a-dir`,
 * `unreadable-archive`.
 */
export const hostFsDirPeek = liveValue("host-fs.peek", {
  schema: HostFsDirPeekSchema,
  params: ["path"],
  refusals: [
    "invalid-path",
    "missing",
    "denied",
    "not-a-dir",
    "unreadable-archive",
  ],
  needsMachine: MACHINE,
});

// ── stat ─────────────────────────────────────────────────────────────────────

export const HostFsPathStatSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entry: HostFsEntrySchema,
  within: HostFsWithinSchema.optional(),
});
export type HostFsPathStat = z.infer<typeof HostFsPathStatSchema>;

/**
 * One host path described (`stat`) — on disk, or a member of an archive.
 * Pushed while read from a watch of the folder holding it (of the archive
 * file's folder, for a member). Refused: `invalid-path`, `missing`, `denied`,
 * `unreadable-archive`.
 */
export const hostFsPathStat = liveValue("host-fs.stat", {
  schema: HostFsPathStatSchema,
  params: ["path"],
  refusals: ["invalid-path", "missing", "denied", "unreadable-archive"],
  needsMachine: MACHINE,
});

// ── text ─────────────────────────────────────────────────────────────────────

export const HostFsFileTextSchema = z.object({
  path: z.string(),
  content: z.string(),
  /** Bytes read. */
  size: z.number(),
});
export type HostFsFileText = z.infer<typeof HostFsFileTextSchema>;

/**
 * A host file as UTF-8 text (`text`), capped at `HOST_FS_TEXT_MAX_BYTES`
 * and binary-sniffed. On demand — up to 2 MiB, so each tab reads it over
 * HTTP — and invalidated while read from a watch of the folder holding it.
 * Refused: `invalid-path`, `missing`, `denied`, `not-a-file`,
 * `unreadable-archive`, `too-large` (past the cap), `binary` (a NUL byte in the
 * first 8 KB).
 */
export const hostFsFileText = liveValue("host-fs.text", {
  schema: HostFsFileTextSchema,
  params: ["path"],
  load: "on-demand",
  refusals: [
    "invalid-path",
    "missing",
    "denied",
    "not-a-file",
    "unreadable-archive",
    "too-large",
    "binary",
  ],
  needsMachine: MACHINE,
});

// ── volume ───────────────────────────────────────────────────────────────────

export const HostFsVolumeInfoSchema = z.object({
  path: z.string(),
  /** The volume's display name ("Macintosh HD", or the `/Volumes/<name>` it is mounted at). */
  name: z.string(),
  /** Bytes. */
  total: z.number(),
  /** Bytes available to the user account. */
  free: z.number(),
});
export type HostFsVolumeInfo = z.infer<typeof HostFsVolumeInfoSchema>;

/**
 * The storage of the volume holding `path` (home when absent) — a SNAPSHOT:
 * free space moves with every write anywhere on the volume and nothing
 * signals it, so it is measured when a reader mounts and on `refresh()`.
 * Refused: `invalid-path`, `missing`, `denied`.
 */
export const hostFsVolumeInfo = liveValue("host-fs.volume", {
  schema: HostFsVolumeInfoSchema,
  params: ["path?"],
  load: "snapshot",
  refusals: ["invalid-path", "missing", "denied"],
  needsMachine: MACHINE,
});
