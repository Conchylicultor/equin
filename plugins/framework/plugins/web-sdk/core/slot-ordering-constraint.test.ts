import { describe, expect, it } from "bun:test";
import type { ComponentType } from "react";
import { defineSlot, type NoOrderingNumber } from "./slots";

// Type-level pins for `defineSlot`'s payload constraint: ordering is never a
// number on a slot contribution. The calls live in a function nothing invokes,
// so no slot is created at runtime — `type-check` is what runs them: each
// `@ts-expect-error` fails the build the moment its line stops being an error.
function typeOnly(): void {
  // @ts-expect-error — a numeric `order` is a position: a render slot's layout.
  defineSlot<{ id: string; order: number }>();
  // @ts-expect-error — optional (undefined-unioned) counts too.
  defineSlot<{ id: string; priority?: number }>();
  // @ts-expect-error — a numeric literal union is still a number.
  defineSlot<{ id: string; rank: 0 | 1 | 2 }>();
  // @ts-expect-error — `weight` too.
  defineSlot<{ id: string; weight: number | null }>();
  // @ts-expect-error — any member of a union payload.
  defineSlot<{ kind: "a"; order: number } | { kind: "b" }>();
  // @ts-expect-error — the companions overload gets it as well.
  defineSlot<{ id: string; order?: number }>({ companions: true });

  // A number named after what it means passes.
  defineSlot<{ id: string; stage: number }>();
  // A non-numeric `order` is not a position number.
  defineSlot<{ id: string; order: "asc" | "desc" }>();
  defineSlot<{ component: ComponentType }>({ companions: true });
}

type Accepted<P> = P extends NoOrderingNumber<P> ? true : false;

describe("defineSlot's ordering constraint", () => {
  it("is a compile-time check (see the @ts-expect-error lines above)", () => {
    const accepted: Accepted<{ id: string; stage: number }> = true;
    const rejected: Accepted<{ id: string; order: number }> = false;
    expect([accepted, rejected, typeof typeOnly]).toEqual([
      true,
      false,
      "function",
    ]);
  });
});
