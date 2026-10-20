import { unavailableMessage } from "@plugins/infra/plugins/endpoints/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { fileBytes, type FileRef } from "../../core";

/**
 * Why a file has no bytes to hand over — a determinate answer about the file,
 * not a failed read. `unsupported` is the source declining to serve them (a
 * folder, an unreadable archive member, a workspace file today);
 * `needs-machine` a read where no computer is behind the app (the in-browser
 * demo): nothing is read.
 */
export type FileBytesUnavailable =
  "too-large" | "missing" | "denied" | "unsupported" | "needs-machine";

export type FileBytesState =
  | { kind: "loading" }
  | { kind: "ok"; bytes: ArrayBuffer }
  | { kind: "unavailable"; reason: FileBytesUnavailable }
  | { kind: "error"; message: string };

/**
 * A file's raw bytes, whichever source holds it — the binary twin of
 * `useFileText`, for a renderer that decodes the format itself (a MIDI file, an
 * archive listing). One read of file-viewer's `file-viewer.bytes` live value,
 * which the server invalidates when a host file changes on disk (from a watch
 * of its folder while it is read). A refusal that is an answer about the file
 * is `unavailable`, never retried; anything else is an `error`.
 */
export function useFileBytes(file: FileRef): FileBytesState {
  const read = useLive(fileBytes, file);
  switch (read.status) {
    case "unavailable":
      return { kind: "unavailable", reason: "needs-machine" };
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ok", bytes: read.data };
    case "error": {
      const { error } = read;
      if (error.kind === "refused") {
        switch (error.code) {
          case "too-large":
          case "missing":
          case "denied":
          case "unsupported":
            return { kind: "unavailable", reason: error.code };
          case "invalid-path":
          case undefined:
            return { kind: "error", message: error.message };
        }
      }
      return { kind: "error", message: error.message };
    }
  }
}

/** The sentence a renderer shows for a file with no bytes to hand over. */
export function fileBytesUnavailableMessage(
  reason: FileBytesUnavailable,
): string {
  switch (reason) {
    case "too-large":
      return "File is too large to preview.";
    case "missing":
      return "File not found.";
    case "denied":
      return "Permission denied — this file cannot be read.";
    case "unsupported":
      return "This file cannot be read from its source.";
    case "needs-machine":
      return unavailableMessage(fileBytes.needsMachine);
  }
}
