/**
 * A UI target a hint or a tour step points at — declared once, in the `core/`
 * of the plugin that owns the element, so another plugin's tour can name it
 * without a deep import.
 *
 * Two shapes:
 *
 * - a **plain** anchor (`defineHintAnchor("improve.button")`) is one element,
 *   and is itself a {@link HintTarget};
 * - a **parameterized** anchor (`defineHintAnchor("conversations.row", (id:
 *   string) => id)`) is a family of elements, one per parameter; `anchor.at(p)`
 *   names one of them as a target.
 *
 * Either way a target resolves to one registry key ({@link targetKey}), which
 * is what the element registers under (`useHintAnchor`) and what a hint or a
 * step looks up.
 */
export interface HintAnchor {
  readonly kind: "hint-anchor";
  readonly id: string;
}

/** A parameterized anchor: a family of elements, one per `P`. */
export interface HintAnchorFamily<P> {
  readonly kind: "hint-anchor-family";
  readonly id: string;
  /** The one element of the family that `params` names. */
  at(params: P): BoundHintAnchor;
}

/** One element of a parameterized anchor family. */
export interface BoundHintAnchor {
  readonly kind: "hint-anchor-bound";
  readonly id: string;
  readonly key: string;
}

/** What a hint, a step or `useHintAnchor` points at: one element. */
export type HintTarget = HintAnchor | BoundHintAnchor;

export function defineHintAnchor(id: string): HintAnchor;
export function defineHintAnchor<P>(
  id: string,
  key: (params: P) => string,
): HintAnchorFamily<P>;
export function defineHintAnchor<P>(
  id: string,
  key?: (params: P) => string,
): HintAnchor | HintAnchorFamily<P> {
  if (id.length === 0) throw new Error("defineHintAnchor: empty id");
  if (key === undefined) return Object.freeze({ kind: "hint-anchor", id });
  return Object.freeze({
    kind: "hint-anchor-family",
    id,
    at: (params: P): BoundHintAnchor =>
      Object.freeze({ kind: "hint-anchor-bound", id, key: key(params) }),
  });
}

/** The registry key a target's element registers and is looked up under. */
export function targetKey(target: HintTarget): string {
  return target.kind === "hint-anchor"
    ? target.id
    : `${target.id}:${target.key}`;
}

/**
 * The `?` help button's anchor. Every tour end pulses it (and holds the
 * toolbar open while it pulses), so the user learns where the tour lives; the
 * help menu registers it on its button.
 */
export const hintsHelpAnchor = defineHintAnchor("hints.help");
