import type { ReactElement, ReactNode } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";

/** One crumb of a path: what it says, and the path it stands for. */
export interface PathSegment {
  key: string;
  label: ReactNode;
  /** The path this crumb navigates to. */
  path: string;
}

/** Where a crumb's menu is opened from: the trail it sits on, and where a place goes. */
export interface PathPlacesAt {
  /**
   * Every path the trail goes through, spelled as its crumbs spell them: the
   * place on it is listed first and marked.
   */
  trail: ReadonlySet<string>;
  /** Where choosing a place goes — `undefined` for a trail that goes nowhere. */
  activationFor: (path: string) => Activation | undefined;
}

/**
 * The places inside `parent` as a crumb's menu: the element that reads them
 * and draws them with `<BreadcrumbPlaces>` (each with what is inside it as a
 * submenu), mounted only while the menu is open — so a level is read when it
 * opens, never ahead. A crumb's siblings are the places inside its parent
 * crumb's path. Children are spelled `parent` + separator + name, the way the
 * crumbs spell them, so the trail marks the right one.
 */
export type PathPlaces = (parent: string, at: PathPlacesAt) => ReactElement;

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
  /**
   * How the field spells `path` when editing starts — a source whose crumbs
   * walk an abbreviated path (`~/…`) spells it in full here, so the field
   * shows the whole place. The completions should be in the same spelling.
   * Default: `path` itself.
   */
  fieldText?: (path: string) => string;
  /**
   * The places beside each crumb: resting the pointer on a crumb lists its
   * parent's places (a click still goes to the crumb). Required — a path
   * space the bar can walk is one whose levels it can list; the first crumb
   * has no parent on the trail, so it has no menu.
   */
  places: PathPlaces;
  /** Resolve a typed path before navigating to it. */
  validate: (path: string) => Promise<PathResolution>;
  /** The path separator. Default `"/"`. */
  separator?: string;
}
