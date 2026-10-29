import type { ClaudeSignInFlow } from "../../core";

// The computer's one sign-in as last published — this backend's memory; a
// restart forgets it (and its Claude Code child dies with the backend).

let flow: ClaudeSignInFlow = { kind: "idle" };
const listeners = new Set<() => void>();

export function currentSignInFlow(): ClaudeSignInFlow {
  return flow;
}

export function publishSignInFlow(next: ClaudeSignInFlow): void {
  flow = next;
  for (const listener of listeners) listener();
}

/** Hear every published step; the returned function stops. */
export function onSignInFlowChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
