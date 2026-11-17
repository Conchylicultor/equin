import {
  checkoutRootOfSync,
  holdSlotLeaseSync,
  type SlotLeaseHold,
} from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";

// The agent host's hold on the checkout it runs from, while it LOADS: taken by
// `./agent-host.ts` before it imports `./agent.ts`, released by `./agent.ts`
// once its static imports are in — the agent host imports nothing after that
// (the Claude CLI it spawns is a clone in the agent's own dir, its shell
// prefix a copy there too), so the slot is free for a build once it is up.
// Held only when that checkout is one of main's slots (infra/git/main-slots).

let hold: SlotLeaseHold | null = null;

/** Hold the agent host's checkout shared (a no-op outside a main slot). */
export function holdAgentBootLeaseSync(): void {
  hold = holdSlotLeaseSync(
    checkoutRootOfSync(import.meta.path),
    "agent-boot",
    "agent-host",
  );
}

/** Release it — the agent host's code is loaded. Idempotent; a no-op when none was taken. */
export function releaseAgentBootLeaseSync(): void {
  if (hold?.kind === "held") hold.release();
  hold = null;
}
