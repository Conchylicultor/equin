/**
 * The build's HANDOVER of its slot (run.ts): a main build holds its slot
 * exclusively while it writes it, and turns the lease shared (`downgrade`)
 * right before anything may run from the slot — a backend or central
 * (re)spawned there boots holding it shared, which the exclusive lease would
 * refuse.
 *
 * `afterHandOver(step)` is for a step that makes something run from the
 * slot (a spec naming it): run at once when there is no slot lease or the
 * handover already happened, otherwise held back and run by `handOver`, right
 * after the downgrade. So no spec ever names a slot its build still holds
 * exclusively — a respawn from it would block behind the build.
 */
export interface HandOver {
  handOver(): Promise<void>;
  afterHandOver(step: () => Promise<void>): Promise<void>;
}

export function createHandOver(
  /** The build's slot lease's downgrade; `null` when the build holds no slot. */
  downgrade: (() => Promise<void>) | null,
): HandOver {
  let handedOver = downgrade === null;
  const pending: (() => Promise<void>)[] = [];
  return {
    async handOver() {
      if (!handedOver) {
        await downgrade!();
        handedOver = true;
      }
      while (pending.length > 0) await pending.shift()!();
    },
    async afterHandOver(step) {
      if (handedOver) await step();
      else pending.push(step);
    },
  };
}
