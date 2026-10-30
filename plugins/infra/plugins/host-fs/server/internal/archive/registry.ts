import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { HostFsArchiveReason } from "../../../core";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** An archive (or one member of it) that cannot be read, and why. */
export type ArchiveUnreadable = {
  kind: "unreadable";
  reason: HostFsArchiveReason;
};

/**
 * One member's bytes. A `Blob` is a byte-exact window of the archive file (a
 * member stored uncompressed), so a `Range` request slices it; a stream (a
 * decompressed member) is served whole.
 */
export type MemberBytes =
  | {
      kind: "ok";
      /** Uncompressed size, in bytes. */
      size: number;
      body: Blob | ReadableStream<Uint8Array>;
    }
  | ArchiveUnreadable;

/**
 * One member of an archive, as its format reads it from the archive's table of
 * contents. `path` is the member's own name (`a/b.txt`, a directory possibly
 * with a trailing `/`); host-fs normalises it, synthesises the directories it
 * implies, and drops a name that would escape the archive (`../x`, `/x`).
 */
export type ArchiveMember =
  | {
      kind: "file";
      path: string;
      size: number;
      mtimeMs: number;
      /** Read the member's bytes (decompressed). */
      open(): Promise<MemberBytes>;
    }
  | { kind: "dir" | "other"; path: string; mtimeMs: number };

export type ArchiveIndexResult =
  { kind: "ok"; members: ArchiveMember[] } | ArchiveUnreadable;

/**
 * A file format host-fs can browse like a folder. A format plugin declares one
 * with `defineArchiveFormat` and lists it in its server `register`; host-fs
 * never names a format.
 */
export interface ArchiveFormat {
  /** Unique, and what an entry's `archive.format` says (`"zip"`). */
  id: string;
  /** Whether a file with this name is one of this format's archives (by extension). */
  claims(name: string): boolean;
  /**
   * Read the archive's table of contents. More than `maxMembers` members is
   * `too-many-entries`; a file that is not a well-formed archive is `corrupt`.
   * Any other I/O error throws (host-fs classifies ENOENT / EACCES).
   */
  index(
    file: UserPath,
    opts: { maxMembers: number },
  ): Promise<ArchiveIndexResult>;
}

const formats = new Map<string, ArchiveFormat>();

/**
 * Declare an archive format. Returns a {@link Registration}: the format joins
 * the registry when the token sits in its plugin's `register: [...]`.
 */
export function defineArchiveFormat(
  format: ArchiveFormat,
): ArchiveFormat & Registration {
  return {
    ...format,
    _kind: "archive-format",
    _factory: "defineArchiveFormat",
    _doc: { label: format.id },
    register() {
      if (formats.has(format.id)) {
        throw new Error(`[host-fs] duplicate archive format id: ${format.id}`);
      }
      formats.set(format.id, format);
    },
  };
}

/** The registered format that claims a file named `name`, if any. */
export function archiveFormatFor(name: string): ArchiveFormat | undefined {
  for (const format of formats.values()) {
    if (format.claims(name)) return format;
  }
  return undefined;
}
