import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { LexicalEditor } from "lexical";

// Single-owner arbiter: at most ONE caret menu is ever open per editor. Two
// triggers can be live in one node (`@friday [[bar|` — `@` and `[[` both match),
// so each hook publishes its candidate `triggerIndex`; the owner is the one
// CLOSEST to the caret (max index). Losers derive `open = false`.
//
// It is a module-level WeakMap keyed on the composer instance — NOT a React
// Provider. A provider you must remember to mount is exactly the "you must also
// update X" coupling this whole primitive exists to delete.

interface Candidate {
  trigger: string;
  triggerIndex: number;
}

/** True when `a` should win over the current best. */
function beats(aId: string, a: Candidate, bId: string, b: Candidate): boolean {
  if (a.triggerIndex !== b.triggerIndex) return a.triggerIndex > b.triggerIndex;
  // Defensive tiebreak — unreachable in practice (two distinct trigger strings
  // cannot start at the same index): longer trigger, then smaller id.
  if (a.trigger.length !== b.trigger.length) return a.trigger.length > b.trigger.length;
  return aId < bId;
}

class Arbiter {
  private candidates = new Map<string, Candidate>();
  private listeners = new Set<() => void>();
  private owner: string | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getOwner = (): string | null => this.owner;

  /** Publish (or, with `triggerIndex === null`, withdraw) a hook's candidacy. */
  publish(id: string, trigger: string, triggerIndex: number | null): void {
    if (triggerIndex === null) {
      if (!this.candidates.delete(id)) return; // nothing to withdraw
    } else {
      const prev = this.candidates.get(id);
      if (prev && prev.trigger === trigger && prev.triggerIndex === triggerIndex) return;
      this.candidates.set(id, { trigger, triggerIndex });
    }
    this.recompute();
  }

  private recompute(): void {
    let winnerId: string | null = null;
    let winner: Candidate | null = null;
    for (const [id, c] of this.candidates) {
      if (winner === null || beats(id, c, winnerId!, winner)) {
        winnerId = id;
        winner = c;
      }
    }
    if (winnerId !== this.owner) {
      this.owner = winnerId;
      for (const listener of this.listeners) listener();
    }
  }
}

const arbiters = new WeakMap<LexicalEditor, Arbiter>();

function getArbiter(editor: LexicalEditor): Arbiter {
  let arbiter = arbiters.get(editor);
  if (!arbiter) {
    arbiter = new Arbiter();
    arbiters.set(editor, arbiter);
  }
  return arbiter;
}

/**
 * Reactive arbiter binding for one hook: `isCaretOwner` re-renders losers via
 * `useSyncExternalStore`, `publish` reports this hook's candidate (called from
 * the update listener, never during render). Withdraws on unmount so a
 * torn-down plugin never holds ownership hostage.
 */
export function useCaretOwner(
  editor: LexicalEditor,
  id: string,
): { isCaretOwner: boolean; publish: (trigger: string, triggerIndex: number | null) => void } {
  const arbiter = getArbiter(editor);
  const isOwner = useCallback(() => arbiter.getOwner() === id, [arbiter, id]);
  // The arbiter is in memory: a static render reads the same owner.
  const isCaretOwner = useSyncExternalStore(
    arbiter.subscribe,
    isOwner,
    isOwner,
  );
  const publish = useCallback(
    (trigger: string, triggerIndex: number | null) => arbiter.publish(id, trigger, triggerIndex),
    [arbiter, id],
  );
  useEffect(() => {
    return () => arbiter.publish(id, "", null);
  }, [arbiter, id]);
  return { isCaretOwner, publish };
}
