import { useQuery } from "@tanstack/react-query";
import {
  EndpointError,
  fetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { getImageContent } from "@plugins/code-explorer/plugins/code-api/core";
import { hostFsRaw } from "@plugins/infra/plugins/host-fs/core";
import { fileRefKey, type FileRef } from "../../core";

/**
 * Why a file has no bytes to hand over — a determinate answer about the file,
 * not a failed read. `unsupported` is the source declining the format (a
 * workspace file is served for image formats only today).
 */
export type FileBytesUnavailable =
  "too-large" | "missing" | "denied" | "unsupported";

export type FileBytesState =
  | { kind: "loading" }
  | { kind: "ok"; bytes: ArrayBuffer }
  | { kind: "unavailable"; reason: FileBytesUnavailable }
  | { kind: "error"; message: string };

// Both raw routes answer a file they will not serve with a status code.
const UNAVAILABLE_BY_STATUS: Record<number, FileBytesUnavailable> = {
  403: "denied",
  404: "missing",
  413: "too-large",
  415: "unsupported",
};

function readBlob(file: FileRef, signal: AbortSignal): Promise<Blob> {
  switch (file.source) {
    case "host":
      return fetchEndpoint(
        hostFsRaw,
        {},
        { query: { path: file.path }, signal },
      );
    case "workspace":
      return fetchEndpoint(
        getImageContent,
        { worktree: file.workspace },
        {
          query: {
            path: file.path,
            ...(file.ref !== undefined ? { ref: file.ref } : {}),
          },
          signal,
        },
      );
  }
}

/**
 * A file's raw bytes, whichever source holds it — the binary twin of
 * `useFileText`, for a renderer that decodes the format itself (a MIDI file, an
 * archive listing). A host file through host-fs's `raw` route, a checkout file
 * through code-api's (as of the ref's revision when it names one). A refusal by
 * status is an `unavailable` answer, never retried; anything else is an
 * `error`.
 */
export function useFileBytes(file: FileRef): FileBytesState {
  const read = useQuery<ArrayBuffer, Error>({
    queryKey: ["file-viewer", "bytes", fileRefKey(file)],
    queryFn: async ({ signal }) => (await readBlob(file, signal)).arrayBuffer(),
    // A status the source answered is the file's answer, not a blip.
    retry: (failures, error) =>
      !(error instanceof EndpointError && error.status < 500) && failures < 3,
  });
  if (read.error) {
    const error = read.error;
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
    return { kind: "error", message: error.message };
  }
  if (read.data === undefined) return { kind: "loading" };
  return { kind: "ok", bytes: read.data };
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
  }
}
