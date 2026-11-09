import { useLive } from "@plugins/network/plugins/live/web";
import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  browserFileBytes,
  checkoutFileBytes,
  computerFileBytes,
  type FileLocation,
} from "../../core";
import { checkoutQuery } from "./queries";

/**
 * Why a file has no bytes to hand over — a determinate answer about the file,
 * not a failed read. `unsupported` is the system declining to serve them (an
 * unreadable archive member, a version of a non-checkout); `unavailable` a
 * file system this host cannot run (nothing is read; `message` says why).
 */
export type FileBytesUnavailable =
  | { reason: "too-large" | "missing" | "denied" | "unsupported" }
  | { reason: "unavailable"; message: string };

export type FileBytesState =
  | { kind: "loading" }
  | { kind: "ok"; bytes: ArrayBuffer }
  | ({ kind: "unavailable" } & FileBytesUnavailable)
  | { kind: "error"; message: string };

type BytesCode =
  | "invalid-path"
  | "missing"
  | "denied"
  | "not-a-file"
  | "unsupported"
  | "too-large";

/** One system's bytes read, as the state every reader shows. */
function bytesState(
  read: ResourceResult<ArrayBuffer, BytesCode> | ResourceUnavailable,
): FileBytesState {
  switch (read.status) {
    case "unavailable":
      return {
        kind: "unavailable",
        reason: "unavailable",
        message: read.message,
      };
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
          case "not-a-file":
            return { kind: "unavailable", reason: "unsupported" };
          case "invalid-path":
          case undefined:
            return { kind: "error", message: error.message };
        }
      }
      return { kind: "error", message: error.message };
    }
  }
}

/**
 * A file's raw bytes, whichever file system holds it — the binary twin of
 * `useFileText`, for a renderer that decodes the format itself (a MIDI file).
 * One read of that system's `bytes` value, which the server invalidates when
 * the file changes. A refusal that is an answer about the file is
 * `unavailable`, never retried; anything else is an `error`.
 */
export function useFileBytes(location: FileLocation): FileBytesState {
  const computer = useLive(
    computerFileBytes,
    location.fs === "computer" ? { path: location.path } : null,
  );
  const browser = useLive(
    browserFileBytes,
    location.fs === "browser" ? { path: location.path } : null,
  );
  const checkout = useLive(
    checkoutFileBytes,
    location.fs === "checkout" ? checkoutQuery(location) : null,
  );
  switch (location.fs) {
    case "computer":
      return bytesState(computer);
    case "browser":
      return bytesState(browser);
    case "checkout":
      return bytesState(checkout);
  }
}

/** The sentence a renderer shows for a file with no bytes to hand over. */
export function fileBytesUnavailableMessage(
  unavailable: FileBytesUnavailable,
): string {
  switch (unavailable.reason) {
    case "too-large":
      return "File is too large to preview.";
    case "missing":
      return "File not found.";
    case "denied":
      return "Permission denied — this file cannot be read.";
    case "unsupported":
      return "This file cannot be read from its source.";
    case "unavailable":
      return unavailable.message;
  }
}
