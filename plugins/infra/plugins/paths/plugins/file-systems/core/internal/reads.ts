import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  assetPath,
  blob,
  defineEndpoint,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import type { FileLocation } from "./location";

// The reads every file system answers, declared once per system (the set is
// closed: `FileSystemKind`). Each system's half serves its own declarations —
// the computer's disk from host-fs's machine half, a browser host's storage
// from data-files' in-browser store, a checkout from code-explorer's machine
// half — and a reader never names one: it hands a `FileLocation` to the web
// hooks (`useFileText` / `useFileBytes` / `useFileStat`) or to `fileUrl`, which
// pick the system's declaration. A system this host cannot run is not broken
// but absent: its declarations are `needsMachine`, so a read of one under a
// transport with no computer behind it is `unavailable` before any request.
//
// Refusals, the same codes on every system (each value declares the ones it
// can give):
// - `invalid-path` — not a path of that system (relative where it must be
//   absolute, escaping the checkout, a NUL, a ref that is not one);
// - `missing` — nothing there (the checkout itself included);
// - `denied` — there, but the user account may not read it;
// - `not-a-file` — a folder where a file is read;
// - `too-large` / `binary` — a file `text` will not decode;
// - `unsupported` — the system does not serve it (an unreadable archive
//   member, a version of a checkout that is not a git checkout).

/** What the computer's disk needs — the same words as host-fs's own reads. */
const COMPUTER = { feature: "Browsing this computer's files" } as const;
/** What a checkout's files need — the same words as code-explorer's reads. */
const CHECKOUT = { feature: "Reading this computer's checkouts" } as const;

// ── shapes ───────────────────────────────────────────────────────────────────

/**
 * What one entry is, judged by what it RESOLVES to (a symlink to a folder is a
 * `dir`). `symlink` is a link that resolves to nothing readable; `other` a
 * socket, FIFO or device.
 */
export const FileEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["dir", "file", "symlink", "other"]),
  /** Bytes. */
  size: z.number(),
  mtimeMs: z.number(),
  birthtimeMs: z.number().optional(),
  /**
   * Last access as the system records it — approximate (relatime / lazy
   * updates, and our own reads bump it). Absent where it is not recorded.
   */
  atimeMs: z.number().optional(),
  /** A dotfile. Presentation only: hidden entries are still listed. */
  hidden: z.boolean(),
  /** The link's own text (`readlink`), present iff the entry is a symlink. */
  symlinkTarget: z.string().optional(),
  /**
   * Present on a real file whose name a registered archive format claims
   * (`.zip`, …): it stays a `file`, and can also be browsed like a folder — a
   * listing of its path lists the archive's root. Never set inside an archive.
   */
  archive: z.object({ format: z.string() }).optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

/**
 * Whether a file's contents can be read, when the system can tell: a path
 * can be described and still not be read (`macos-privacy`: a folder macOS
 * keeps the app out of; `permissions`: the file's own mode).
 */
export const FileReadAccessSchema = z.enum([
  "readable",
  "macos-privacy",
  "permissions",
]);
export type FileReadAccess = z.infer<typeof FileReadAccessSchema>;

/**
 * Where macOS keeps equin's per-folder switches (Privacy & Security → Files &
 * Folders): the equin app bundle gets a switch per protected folder there, a
 * denied one included, so this is where a `macos-privacy` read access is
 * undone. A page opens it as a link.
 */
export const MACOS_FILES_AND_FOLDERS_SETTINGS =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

/**
 * Set on a path that lies INSIDE an archive (`…/photos.zip/2022/a.jpg`): it is
 * virtual, so it cannot be moved, opened with its default app, or have a git
 * status, and it is revealed as the archive file itself.
 */
export const FileWithinSchema = z.object({
  /** The archive file, in the system's absolute spelling. */
  archive: z.string(),
  format: z.string(),
});
export type FileWithin = z.infer<typeof FileWithinSchema>;

/** One path described. */
export const FileStatSchema = z.object({
  /** The path as the system resolves it (`~` expanded, `.`/`..` collapsed). */
  path: z.string(),
  /** The folder holding it, in the same spelling; `null` at the system's root. */
  parent: z.string().nullable(),
  entry: FileEntrySchema,
  within: FileWithinSchema.optional(),
  /** Absent when the system cannot tell (or on an unresolvable symlink). */
  read: FileReadAccessSchema.optional(),
});
export type FileStat = z.infer<typeof FileStatSchema>;

/** The largest file `text` decodes (2 MiB). */
export const FILE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export const FileTextSchema = z.object({
  content: z.string(),
  /** Bytes read. */
  size: z.number(),
});
export type FileText = z.infer<typeof FileTextSchema>;

/** The largest file whose bytes are handed over whole (64 MiB). */
export const FILE_BYTES_MAX = 64 * 1024 * 1024;

const PathQuerySchema = z.object({ path: z.string() });
const CheckoutQuerySchema = z.object({
  checkout: z.string(),
  path: z.string(),
  version: z.string().optional(),
});

const STAT_REFUSALS = [
  "invalid-path",
  "missing",
  "denied",
  "unsupported",
] as const;
const TEXT_REFUSALS = [
  "invalid-path",
  "missing",
  "denied",
  "not-a-file",
  "too-large",
  "binary",
  "unsupported",
] as const;
const BYTES_REFUSALS = [
  "invalid-path",
  "missing",
  "denied",
  "not-a-file",
  "unsupported",
] as const;

// ── computer ─────────────────────────────────────────────────────────────────

/** A path on the computer's disk described, pushed while read from a watch of it. */
export const computerFileStat = liveValue("files.computer.stat", {
  schema: FileStatSchema,
  params: ["path"],
  refusals: STAT_REFUSALS,
  needsMachine: COMPUTER,
});

/**
 * A file on the computer's disk as UTF-8 text, capped at
 * {@link FILE_TEXT_MAX_BYTES} and binary-sniffed (a NUL in the first 8 KB). On
 * demand, invalidated while read from a watch of it.
 */
export const computerFileText = liveValue("files.computer.text", {
  schema: FileTextSchema,
  params: ["path"],
  load: "on-demand",
  refusals: TEXT_REFUSALS,
  needsMachine: COMPUTER,
});

/** A file on the computer's disk as bytes (up to {@link FILE_BYTES_MAX}), on demand. */
export const computerFileBytes = liveValue("files.computer.bytes", {
  bytes: true,
  params: ["path"],
  maxBytes: FILE_BYTES_MAX,
  refusals: BYTES_REFUSALS,
  needsMachine: COMPUTER,
});

/**
 * `GET /api/files/computer/raw?path=` — the bytes of a file on the computer's
 * disk, streamed, `Range` honoured (one range → 206 / 416). 404 / 403 / 400 (a
 * folder) / 422 (an unreadable archive member).
 */
export const computerFileRaw = defineEndpoint({
  route: "GET /api/files/computer/raw",
  query: PathQuerySchema,
  response: blob(),
  needsMachine: COMPUTER,
});

// ── browser ──────────────────────────────────────────────────────────────────

/** A path in the browser's storage described, pushed while read. */
export const browserFileStat = liveValue("files.browser.stat", {
  schema: FileStatSchema,
  params: ["path"],
  refusals: STAT_REFUSALS,
});

/** A file in the browser's storage as UTF-8 text (as {@link computerFileText}). */
export const browserFileText = liveValue("files.browser.text", {
  schema: FileTextSchema,
  params: ["path"],
  load: "on-demand",
  refusals: TEXT_REFUSALS,
});

/** A file in the browser's storage as bytes, on demand. */
export const browserFileBytes = liveValue("files.browser.bytes", {
  bytes: true,
  params: ["path"],
  maxBytes: FILE_BYTES_MAX,
  refusals: BYTES_REFUSALS,
});

/**
 * `GET /api/files/browser/raw?path=` — a file in the browser's storage,
 * verbatim, served inert (`nosniff`, `sandbox` CSP but for a PDF). 404 for
 * nothing there or a folder, 400 for a path that is not one.
 */
export const browserFileRaw = defineEndpoint({
  route: "GET /api/files/browser/raw",
  query: PathQuerySchema,
  response: blob(),
});

// ── checkout ─────────────────────────────────────────────────────────────────

/**
 * A checkout's file as UTF-8 text — as on disk now, or AS OF `version` (a
 * checkout's git ref: `HEAD`, `main`, a sha). On demand, invalidated while
 * read from the file's watch (on disk) or the checkout's refs (a named ref; a
 * sha never moves).
 */
export const checkoutFileText = liveValue("files.checkout.text", {
  schema: FileTextSchema,
  params: ["checkout", "path", "version?"],
  load: "on-demand",
  refusals: TEXT_REFUSALS,
  needsMachine: CHECKOUT,
});

/** A checkout's file as bytes (on disk now, or as of `version`), on demand. */
export const checkoutFileBytes = liveValue("files.checkout.bytes", {
  bytes: true,
  params: ["checkout", "path", "version?"],
  maxBytes: FILE_BYTES_MAX,
  refusals: BYTES_REFUSALS,
  needsMachine: CHECKOUT,
});

/**
 * `GET /api/files/checkout/raw?checkout=&path=&version=` — a checkout's file,
 * on disk now (streamed, `Range` honoured) or as of `version` (its blob).
 */
export const checkoutFileRaw = defineEndpoint({
  route: "GET /api/files/checkout/raw",
  query: CheckoutQuerySchema,
  response: blob(),
  needsMachine: CHECKOUT,
});

// ── one asset per location ───────────────────────────────────────────────────

/**
 * The asset the browser reads a file's raw bytes from — for an `<img>`, an
 * `<iframe>`, a `<video>`, a download — resolved to a `src` by `useAssetSrc`
 * (`endpoints/web`) over the subtree's transport, so a file in the browser's
 * storage is served by the in-browser host and never by the page's server.
 * Every system serves every file through it: a reader never asks which.
 */
export function fileUrl(location: FileLocation): AssetPath {
  switch (location.fs) {
    case "computer":
      return assetPath(computerFileRaw, {}, { path: location.path });
    case "browser":
      return assetPath(browserFileRaw, {}, { path: location.path });
    case "checkout":
      return assetPath(
        checkoutFileRaw,
        {},
        {
          checkout: location.checkout,
          path: location.path,
          ...(location.version !== undefined
            ? { version: location.version }
            : {}),
        },
      );
  }
}
