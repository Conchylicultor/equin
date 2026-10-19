import {
  useEndpoint,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import { getFileContent } from "@plugins/code-explorer/plugins/code-api/core";
import {
  hostFsText,
  type HostFsTextResult,
} from "@plugins/infra/plugins/host-fs/core";
import type { FileRef } from "../../core";
import { useRefetchOnFileChange } from "./use-file-revision";

/**
 * Why a file has no text to show — a determinate answer about the file, not a
 * failed read: the renderer says so in words ("Binary file", "too large")
 * rather than as an error.
 */
export type FileTextUnavailable = "too-large" | "binary" | "missing" | "denied";

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

// host-fs's `text` route answers the same cases as a discriminated body.
function hostState(result: HostFsTextResult): FileTextState {
  switch (result.kind) {
    case "ok":
      return { kind: "ok", content: result.content };
    case "too-large":
    case "binary":
    case "missing":
    case "denied":
      return { kind: "unavailable", reason: result.kind };
    case "not-a-file":
      return { kind: "error", message: `Not a file: ${result.path}` };
    case "unreadable-archive":
      return {
        kind: "error",
        message: `Unreadable archive member (${result.reason}): ${result.path}`,
      };
  }
}

/**
 * A file's text, whichever source holds it: a workspace file through code-api's
 * `file` route (as of the ref's revision when it names one), a host file
 * through host-fs's `text` route. Both reads are declared every render (hooks
 * cannot be conditional) and the one for the other source stays disabled.
 * Re-read in place whenever the file changes on disk (`useFileRevision`): the
 * text on screen stays until the new one lands.
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
  const hostRead = useEndpoint(
    hostFsText,
    {},
    { query: { path: host?.path ?? "" }, enabled: host !== null },
  );
  useRefetchOnFileChange(file, ws !== null ? wsRead.refetch : hostRead.refetch);

  if (ws !== null) {
    if (wsRead.error) return failureState(wsRead.error);
    if (!wsRead.data) return { kind: "loading" };
    return { kind: "ok", content: wsRead.data.content };
  }
  if (hostRead.error) return failureState(hostRead.error);
  if (!hostRead.data) return { kind: "loading" };
  return hostState(hostRead.data);
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
  }
}
