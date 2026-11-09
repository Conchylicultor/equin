import { fileExtension } from "@plugins/primitives/plugins/file-viewer/core";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

export type MediaKind = "video" | "audio";

// Containers a browser media element may play. Whether it actually can
// depends on the codec inside (an HEVC .mov, most .mkv/.avi in Chrome), which
// only the element can tell — a file it cannot decode falls back to "No
// preview". MIDI is not audio here: Sonata's file preview renders it.
const EXTS: Record<MediaKind, ReadonlySet<string>> = {
  video: new Set(["mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi"]),
  audio: new Set(["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac"]),
};

/** By extension, in any file system: every one serves the bytes (`fileUrl`). */
export function supportsMedia(
  kind: MediaKind,
  file: FileLocation,
): "native" | false {
  return EXTS[kind].has(fileExtension(file.path)) ? "native" : false;
}
