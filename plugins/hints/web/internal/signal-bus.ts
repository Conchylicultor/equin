import type { HintSignal } from "../../core";

type SignalListener = (id: string, payload: unknown) => void;

const listeners = new Set<SignalListener>();

/**
 * Tells the hints engine an app event happened — e.g. Improve's send emitting
 * `improveSent` with the filed task ids. A running tour step whose `advanceOn`
 * is this signal moves on; nothing listens otherwise, so emitting is free.
 */
export function emitHintSignal<T>(
  signal: HintSignal<T>,
  ...payload: T extends void ? [] : [T]
): void {
  for (const l of listeners) l(signal.id, payload[0]);
}

export function subscribeHintSignals(cb: SignalListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
