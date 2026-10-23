/**
 * A typed app event a tour step can wait on (`advanceOn`), e.g. `improve.sent`
 * carrying the filed task ids. Declared in the `core/` of the plugin that
 * emits it; the emitter calls `emitHintSignal(signal, payload)` (hints/web).
 *
 * `T` is a phantom: it only types the payload at the emit and the listen site.
 */
export interface HintSignal<T> {
  readonly kind: "hint-signal";
  readonly id: string;
  /** Phantom — never set; carries the payload type. */
  readonly __payload?: T;
}

export function defineHintSignal<T = void>(id: string): HintSignal<T> {
  if (id.length === 0) throw new Error("defineHintSignal: empty id");
  return Object.freeze({ kind: "hint-signal", id });
}
