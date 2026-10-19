import { useSyncExternalStore } from "react";

const state = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

function notify(conversationId: string): void {
  listeners.get(conversationId)?.forEach((l) => l());
}

export function setIsOpen(conversationId: string, value: boolean): void {
  if ((state.get(conversationId) ?? false) === value) return;
  state.set(conversationId, value);
  notify(conversationId);
}

export function toggleIsOpen(conversationId: string): void {
  setIsOpen(conversationId, !getIsOpen(conversationId));
}

function getIsOpen(conversationId: string): boolean {
  return state.get(conversationId) ?? false;
}

export function useIsOpen(conversationId: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(conversationId);
      if (!set) {
        set = new Set();
        listeners.set(conversationId, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    () => getIsOpen(conversationId),
    () => false,
  );
}
