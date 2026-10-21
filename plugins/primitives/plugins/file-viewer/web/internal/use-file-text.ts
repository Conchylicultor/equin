import { unavailableMessage } from "@plugins/infra/plugins/endpoints/core";
import { codeFile } from "@plugins/code-explorer/plugins/code-api/core";
import { hostFsFileText } from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import type { FileRef } from "../../core";

/**
 * Why a file has no text to show — a determinate answer about the file, not a
 * failed read: the renderer says so in words ("Binary file", "too large")
 * rather than as an error. `needs-machine` is a read where no computer is
 * behind the app (the in-browser demo): nothing is read.
 */
export type FileTextUnavailable =
  "too-large" | "binary" | "missing" | "denied" | "needs-machine";

export type FileTextState =
  | { kind: "loading" }
  | { kind: "ok"; content: string }
  | { kind: "unavailable"; reason: FileTextUnavailable }
  | { kind: "error"; message: string };

/**
 * A file's text, whichever source holds it — one live read each: a workspace
 * file through code-api's `code.file` (as it is on disk now, or as of the
 * ref's revision when it names one), a host file through host-fs's
 * `host-fs.text`. The server invalidates both while they are read (a watch of
 * the file, or the checkout's git dir for a named ref; a sha never moves), and
 * the text on screen stays until the new one lands. Both reads are declared
 * every render (hooks cannot be conditional) and the one for the other source
 * reads nothing.
 */
export function useFileText(file: FileRef): FileTextState {
  const ws = file.source === "workspace" ? file : null;
  const host = file.source === "host" ? file : null;

  const wsRead = useLive(
    codeFile,
    ws === null
      ? null
      : {
          worktree: ws.workspace,
          path: ws.path,
          ...(ws.ref !== undefined ? { ref: ws.ref } : {}),
        },
  );
  const hostRead = useLive(
    hostFsFileText,
    host === null ? null : { path: host.path },
  );

  if (ws !== null) {
    // code-api refuses the cases it will not read: the ones that are an
    // answer about the file are `unavailable` (a workspace that is not there
    // reads as the file not being there, as the route's 404 did), the rest (a
    // malformed path or ref, a git read of a non-checkout, an unreadable
    // archive) an error carrying the server's own words.
    switch (wsRead.status) {
      case "unavailable":
        return { kind: "unavailable", reason: "needs-machine" };
      case "loading":
        return { kind: "loading" };
      case "ready":
        return { kind: "ok", content: wsRead.data.content };
      case "error": {
        const { error } = wsRead;
        if (error.kind === "refused") {
          switch (error.code) {
            case "too-large":
            case "binary":
            case "missing":
            case "denied":
              return { kind: "unavailable", reason: error.code };
            case "no-workspace":
              return { kind: "unavailable", reason: "missing" };
            case "not-a-checkout":
            case "invalid-ref":
            case "invalid-path":
            case "unreadable-archive":
            case undefined:
              return { kind: "error", message: error.message };
          }
        }
        return { kind: "error", message: error.message };
      }
    }
  }
  // host-fs refuses the cases it will not read: the ones that are an answer
  // about the file are `unavailable`, the rest (a malformed path, a folder, an
  // unreadable archive) an error carrying the server's own words.
  switch (hostRead.status) {
    case "unavailable":
      return { kind: "unavailable", reason: "needs-machine" };
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ok", content: hostRead.data.content };
    case "error": {
      const { error } = hostRead;
      if (error.kind === "refused") {
        switch (error.code) {
          case "too-large":
          case "binary":
          case "missing":
          case "denied":
            return { kind: "unavailable", reason: error.code };
          case "invalid-path":
          case "not-a-file":
          case "unreadable-archive":
          case undefined:
            return { kind: "error", message: error.message };
        }
      }
      return { kind: "error", message: error.message };
    }
  }
}

/** The sentence a renderer shows for a file with no text to show. */
export function fileTextUnavailableMessage(
  reason: FileTextUnavailable,
): string {
  switch (reason) {
    case "too-large":
      return "File is too large to preview.";
    case "binary":
      return "Binary file — no preview available.";
    case "missing":
      return "File not found.";
    case "denied":
      return "Permission denied — this file cannot be read.";
    case "needs-machine":
      return unavailableMessage(hostFsFileText.needsMachine);
  }
}
