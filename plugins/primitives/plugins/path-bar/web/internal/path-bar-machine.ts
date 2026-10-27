/**
 * The path bar's editing state machine, pure so it is tested without a DOM.
 *
 *   crumbs ──start──▶ editing ──commit ok / cancel──▶ crumbs
 *                       │ ▲
 *                       └─┘ input · move · complete · validating · invalid
 *
 * The suggestions are not state: they are the source's live read of the text
 * now in the field (`PathBarSource.useComplete`), passed into the transitions
 * that need them — so an answer to an earlier keystroke has nowhere to land.
 */
import type { Suggestions } from "./types";

/** How many suggestions the popover lists. */
export const MAX_SUGGESTIONS = 8;

export type PathBarState =
  | { mode: "crumbs" }
  | {
      mode: "editing";
      text: string;
      /** Index into the shown items, or -1 for none (Enter commits the text). */
      highlighted: number;
      /** A commit is being validated: the field is read-only meanwhile. */
      validating: boolean;
      /** The last commit did not resolve; the reason is shown under the field. */
      invalid: { reason: string } | null;
    };

export type PathBarAction =
  | { type: "start"; text: string }
  | { type: "input"; text: string }
  | { type: "move"; delta: 1 | -1; items: readonly string[] }
  | { type: "complete"; separator: string; items: readonly string[] }
  | { type: "validating" }
  | { type: "invalid"; reason: string }
  | { type: "cancel" };

export const CRUMBS: PathBarState = { mode: "crumbs" };

/** The text the field opens with: the current path plus one separator, so the
 *  first keystroke already lists the current folder's children. */
export function editText(path: string, separator: string): string {
  return path.endsWith(separator) ? path : path + separator;
}

export function pathBarReducer(
  state: PathBarState,
  action: PathBarAction,
): PathBarState {
  if (action.type === "start") {
    return {
      mode: "editing",
      text: action.text,
      highlighted: -1,
      validating: false,
      invalid: null,
    };
  }
  if (state.mode !== "editing") return state;
  switch (action.type) {
    case "input":
      return {
        ...state,
        text: action.text,
        highlighted: -1,
        invalid: null,
      };
    case "move": {
      const n = action.items.length;
      if (n === 0) return state;
      const at = highlightedIn(state, action.items);
      const from = at < 0 ? (action.delta > 0 ? -1 : 0) : at;
      return { ...state, highlighted: (from + action.delta + n) % n };
    }
    case "complete": {
      const { items } = action;
      if (items.length === 0) return state;
      const pick = items[Math.max(0, highlightedIn(state, items))]!;
      return pathBarReducer(state, {
        type: "input",
        text: editText(pick, action.separator),
      });
    }
    case "validating":
      return { ...state, validating: true, invalid: null };
    case "invalid":
      return {
        ...state,
        validating: false,
        invalid: { reason: action.reason },
      };
    case "cancel":
      return CRUMBS;
  }
}

/** The suggestions the list shows: the first {@link MAX_SUGGESTIONS} of a
 *  ready answer, none while pending or failed. */
export function shownItems(suggestions: Suggestions): readonly string[] {
  return suggestions.kind === "ready"
    ? suggestions.items.slice(0, MAX_SUGGESTIONS)
    : [];
}

/**
 * The highlighted index into `items`, or -1 — a highlight past the end (the
 * list shrank under it: a folder went while it was shown) highlights nothing.
 */
export function highlightedIn(
  state: PathBarState,
  items: readonly string[],
): number {
  if (state.mode !== "editing") return -1;
  return state.highlighted < items.length ? state.highlighted : -1;
}

/**
 * What Enter commits: the highlighted suggestion, else the typed text — with a
 * trailing separator dropped (`/Users/me/` names `/Users/me`), except for the
 * root itself.
 */
export function commitTarget(
  state: PathBarState,
  items: readonly string[],
  separator: string,
): string {
  if (state.mode !== "editing") return "";
  const at = highlightedIn(state, items);
  const raw = at >= 0 ? items[at]! : state.text.trim();
  return raw.length > separator.length && raw.endsWith(separator)
    ? raw.slice(0, -separator.length)
    : raw;
}

/**
 * A suggestion split for display: its parent part, the run of its last segment
 * the typed stem matched (bold), and the rest. The match is case-insensitive,
 * preferring a prefix of the segment; a stem that does not occur leaves the
 * match empty.
 */
export function splitSuggestion(
  suggestion: string,
  typed: string,
  separator: string,
): { parent: string; match: string; rest: string } {
  const cut = suggestion.lastIndexOf(separator);
  const parent = cut < 0 ? "" : suggestion.slice(0, cut + separator.length);
  const name = cut < 0 ? suggestion : suggestion.slice(cut + separator.length);
  const typedCut = typed.lastIndexOf(separator);
  const stem = typedCut < 0 ? typed : typed.slice(typedCut + separator.length);
  if (!stem) return { parent, match: "", rest: name };
  const at = name.toLowerCase().indexOf(stem.toLowerCase());
  if (at < 0) return { parent, match: "", rest: name };
  return {
    parent: parent + name.slice(0, at),
    match: name.slice(at, at + stem.length),
    rest: name.slice(at + stem.length),
  };
}
