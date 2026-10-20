import {
  useEndpoint,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import { unavailableMessage } from "@plugins/infra/plugins/endpoints/core";
import { getFileContent } from "@plugins/code-explorer/plugins/code-api/core";
import { hostFsFileText } from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import type { FileRef } from "../../core";
import { useRefetchOnFileChange } from "./use-file-revision";

/**
 * Why a file has no text to show — a determinate answer about the file, not a
 * failed read: the renderer says so in words ("Binary file", "too large")
 * rather than as an error. `needs-machine` is a host file read where no
 * computer is behind the app (the in-browser demo): nothing is read.
 */
export type FileTextUnavailable =
  "too-large" | "binary" | "missing" | "denied" | "needs-machine";

export type FileTextState =
  | { kind: "loading" }
  | { kind: "ok"; content: string }
  | { kind: "unavailable"; reason: FileTextUnavailable }
  | { kind: "error"; message: string };

// code-api's `file` route answers a file it will not read with a status code —
// 413 too large, 415 binary, 404 gone, 403 not readable.
const UNAVAILABLE_BY_STATUS: Record<number, FileTextUnavailable> = {
  403: "denied",
  404: "missing",
  413: "too-large",
  415: "binary",
};

function failureState(error: Error): FileTextState {
  if (error instanceof EndpointError) {
    const reason = UNAVAILABLE_BY_STATUS[error.status];
    if (reason) return { kind: "unavailable", reason };
    return {
      kind: "error",
      message:
        typeof error.body === "string" && error.body
          ? error.body
          : `HTTP ${error.status}`,
    };
  }
  return { kind: "error", message: String(error) };
}

/**
 * A file's text, whichever source holds it: a workspace file through code-api's
 * `file` route (as of the ref's revision when it names one) — re-read in place
 * whenever the file changes on disk (`useFileRevision`), the text on screen
 * staying until the new one lands — and a host file through host-fs's
 * `host-fs.text` live value, which the server invalidates from a watch of the
 * file's folder while it is read. Both reads are declared every render (hooks
 * cannot be conditional) and the one for the other source reads nothing.
 */
export function useFileText(file: FileRef): FileTextState {
  const ws = file.source === "workspace" ? file : null;
  const host = file.source === "host" ? file : null;

  const wsRead = useEndpoint(
    getFileContent,
    { worktree: ws?.workspace ?? "" },
    {
      query: {
        path: ws?.path ?? "",
        ...(ws?.ref !== undefined ? { ref: ws.ref } : {}),
      },
      enabled: ws !== null,
    },
  );
  useRefetchOnFileChange(ws, wsRead.refetch);
  const hostRead = useLive(
    hostFsFileText,
    host === null ? null : { path: host.path },
  );

  if (ws !== null) {
    if (wsRead.error) return failureState(wsRead.error);
    if (!wsRead.data) return { kind: "loading" };
    return { kind: "ok", content: wsRead.data.content };
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
