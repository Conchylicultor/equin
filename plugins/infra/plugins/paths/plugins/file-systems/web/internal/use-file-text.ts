import { useLive } from "@plugins/network/plugins/live/web";
import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  browserFileText,
  checkoutFileText,
  computerFileText,
  type FileLocation,
  type FileText,
} from "../../core";
import { checkoutQuery } from "./queries";

/**
 * Why a file has no text to show — a determinate answer about the file, not a
 * failed read: the renderer says so in words ("Binary file", "too large")
 * rather than as an error. `unavailable` is a file system this host cannot
 * run (the computer's disk in the in-browser demo): nothing is read, and
 * `message` says what is missing.
 */
export type FileTextUnavailable =
  | { reason: "too-large" | "binary" | "missing" | "denied" }
  | { reason: "unavailable"; message: string };

export type FileTextState =
  | { kind: "loading" }
  | { kind: "ok"; content: string }
  | ({ kind: "unavailable" } & FileTextUnavailable)
  | { kind: "error"; message: string };

type TextCode =
  | "invalid-path"
  | "missing"
  | "denied"
  | "not-a-file"
  | "too-large"
  | "binary"
  | "unsupported";

/** One system's text read, as the state every reader shows. */
function textState(
  read: ResourceResult<FileText, TextCode> | ResourceUnavailable,
): FileTextState {
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
      return { kind: "ok", content: read.data.content };
    case "error": {
      const { error } = read;
      // A refusal about the file is an answer to show; a malformed path, a
      // folder or a source that cannot serve it is an error in the server's
      // own words.
      if (error.kind === "refused") {
        switch (error.code) {
          case "too-large":
          case "binary":
          case "missing":
          case "denied":
            return { kind: "unavailable", reason: error.code };
          case "invalid-path":
          case "not-a-file":
          case "unsupported":
          case undefined:
            return { kind: "error", message: error.message };
        }
      }
      return { kind: "error", message: error.message };
    }
  }
}

/**
 * A file's text, whichever file system holds it: one live read of that
 * system's `text` (on demand, invalidated by the server while read, the text
 * on screen kept until the new one lands). Every system's read is declared
 * every render (hooks cannot be conditional); the others read nothing.
 */
export function useFileText(location: FileLocation): FileTextState {
  const computer = useLive(
    computerFileText,
    location.fs === "computer" ? { path: location.path } : null,
  );
  const browser = useLive(
    browserFileText,
    location.fs === "browser" ? { path: location.path } : null,
  );
  const checkout = useLive(
    checkoutFileText,
    location.fs === "checkout" ? checkoutQuery(location) : null,
  );
  switch (location.fs) {
    case "computer":
      return textState(computer);
    case "browser":
      return textState(browser);
    case "checkout":
      return textState(checkout);
  }
}

/** The sentence a renderer shows for a file with no text to show. */
export function fileTextUnavailableMessage(
  unavailable: FileTextUnavailable,
): string {
  switch (unavailable.reason) {
    case "too-large":
      return "File is too large to preview.";
    case "binary":
      return "Binary file — no preview available.";
    case "missing":
      return "File not found.";
    case "denied":
      return "Permission denied — this file cannot be read.";
    case "unavailable":
      return unavailable.message;
  }
}
