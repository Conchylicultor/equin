/**
 * Compile-only negative type guard for `useOptimisticResource`'s options.
 *
 * The paired-field invariant (`isConfirmedBy` present ⟺ `sameTarget` present) is
 * encoded as a discriminated union on `OptimisticOptions`. This file asserts —
 * at the type level, validated by the `type-check` tsconfig `test` target —
 * that each half of the pair alone is REJECTED. If either constraint regresses,
 * the corresponding `@ts-expect-error` becomes unused and tsc fails on the
 * now-dead directive — the guard.
 *
 * Everything here is erased at runtime: the sole imports are `import type`, the
 * stubs are `declare const`, and the assertions live in never-invoked
 * functions. `bun test` imports this module with zero side effects (and no
 * runtime assertions), so it neither pulls the React/live-state module graph
 * nor executes any hook. Each assignment is a single line, so any type error
 * within it lands on that exact line, right under its directive.
 */

import type { LiveValue } from "@plugins/network/plugins/live/core";
import type {
  OptimisticOptions,
  useOptimisticResource,
} from "./use-optimistic-resource";

type Row = { id: string };
type Vars = { id: string };

type Options = OptimisticOptions<Row[], Vars>;

declare const apply: (current: Row[], vars: Vars) => Row[];
declare const mutate: (vars: Vars) => Promise<void>;
declare const mutateWithToken: (vars: Vars) => Promise<{ watermark?: string }>;
declare const isConfirmedBy: (serverData: Row[], vars: Vars) => boolean;
declare const sameTarget: (a: Vars, b: Vars) => boolean;

export function _optimisticConfirmationArgsGuard(): void {
  // Content-based arm: BOTH fields together type-check.
  const ok1: Options = { apply, mutate, isConfirmedBy, sameTarget };
  // Coarse arm: NEITHER field type-checks.
  const ok2: Options = { apply, mutate };
  // `mutate` widened to `Promise<void | { watermark? }>`: an ack-token-returning
  // mutate is accepted (Rule A upgrade) AND the tokenless `Promise<void>` above
  // stays assignable — backward-compatible by construction.
  const ok3: Options = { apply, mutate: mutateWithToken };
  // @ts-expect-error — isConfirmedBy requires sameTarget (unrepresentable alone)
  const bad1: Options = { apply, mutate, isConfirmedBy };
  // @ts-expect-error — sameTarget requires isConfirmedBy (unrepresentable alone)
  const bad2: Options = { apply, mutate, sameTarget };
  void ok1;
  void ok2;
  void ok3;
  void bad1;
  void bad2;
}

declare const value: LiveValue<Row[], Record<string, never>>;
declare const hook: typeof useOptimisticResource;

export function _optimisticPositionalGuard(): void {
  // The hook's own options keep the confirmation pair all-or-nothing too.
  // @ts-expect-error — isConfirmedBy requires sameTarget
  hook(value, { apply, mutate, isConfirmedBy });
  const r = hook(value, { apply, mutate, isConfirmedBy, sameTarget });
  if (r.status !== "ready") {
    // @ts-expect-error — no dispatch before the ready arm
    void r.dispatch;
  } else {
    void r.dispatch;
  }
}
