import type { ReactNode } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/** One crumb of a path: what it says, and the path it stands for. */
export interface PathSegment {
  key: string;
  label: ReactNode;
  /** The path this crumb navigates to. */
  path: string;
}

/** What a typed path turned out to be. */
export type PathResolution =
  | { kind: "dir"; path: string }
  | { kind: "file"; path: string }
  /** Not a place this source can go; `reason` is shown under the field. */
  | { kind: "invalid"; path: string; reason?: string };

/**
 * The completions of the text in the field, as the source's read of them
 * stands now: not known yet, the list, or why there is none. `ready` with no
 * items is an answer (nothing completes the text); a read that failed is
 * `failed`, shown in the panel — never an empty list standing in.
 */
export type Suggestions =
  | { kind: "pending" }
  | { kind: "ready"; items: readonly string[] }
  | { kind: "failed"; message: string };

/** Where the path bar navigates to — a resolved `dir` or `file`, never `invalid`. */
export type PathTarget = Extract<PathResolution, { kind: "dir" | "file" }>;

/**
 * Everything the path bar knows about a path space. Generic on purpose — a
 * host directory tree, a git ref's tree, a page hierarchy — so the bar imports
 * no filesystem and a second path space is a second source, not a second bar.
 */
export interface PathBarSource {
  /** The crumbs of `path`, root first; the last is the current place. */
  segments: (path: string) => PathSegment[];
  /**
   * A hook reading the containers completing `prefix` — the text typed so
   * far, up to and past its last separator — as full paths WITHOUT a trailing
   * separator; `null` while the bar is not editing (nothing is read). A live
   * read: the bar renders whatever it answers now, so an answer to an older
   * keystroke cannot land on newer text. The bar shows the first few and
   * appends the separator itself when one is completed.
   */
  useComplete: Hook<(prefix: string | null) => Suggestions>;
  /** Resolve a typed path before navigating to it. */
  validate: (path: string) => Promise<PathResolution>;
  /** The path separator. Default `"/"`. */
  separator?: string;
}
