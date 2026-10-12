import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { kindLabel, type AnyIdKind } from "../core";

/**
 * What a presenter knows about one id right now. Not-known-yet is a state, and
 * a failed read is not "missing": a consumer must not render an existing
 * referent as if it were gone because its list failed to load.
 */
export type IdReferentState =
  | { status: "loading" }
  | { status: "found"; title: string }
  | { status: "missing" }
  | { status: "failed"; error: Error };

/**
 * How one kind's ids are SHOWN and OPENED in the browser — the generic "what
 * is this id, how do I open it" a chip, a picker or a link renders from.
 * Optional and separate from the kind itself, so `ids` stays below the UI: a
 * kind with no presenter is recognised and validated, just not rendered.
 */
export interface IdPresenter {
  kind: AnyIdKind;
  /** The glyph a generic rendering leads with; a kind may have none. */
  icon?: IconRef;
  /** The referent's title, or that it does not exist (or is still loading). */
  useReferent: Hook<(id: string) => IdReferentState>;
  /**
   * The link to the referent (a pane, beside the surface holding the id): its
   * plain open, and the URL a ⌘/middle-click opens in a new browser tab.
   */
  useTarget: Hook<() => (id: string) => LinkTarget>;
}

/**
 * The id-kind registry, web half. Kinds are an OPEN set — any plugin declares
 * one in its own `core/` and registers it here — so consumers read the slot
 * (`useIdKinds()`), never a list.
 *
 * - `Kind` — one declared kind. The server half registers the same kinds
 *   (`ids:kind-both-runtimes`).
 * - `Presenter` — how a kind's ids render and open (optional per kind).
 */
export const IdKinds = {
  Kind: defineSlot<{ kind: AnyIdKind }>({ docLabel: (p) => kindLabel(p.kind) }),
  Presenter: defineSlot<IdPresenter>({ docLabel: (p) => p.kind.prefix }),
};
