import type { ReactNode } from "react";
import {
  defineSlot,
  defineSlotFacade,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import type { EntityExposure } from "@plugins/infra/plugins/entity-extensions/core";

// The browser half of exposed fields (`../../CLAUDE.md`, "Exposed fields"): an
// extension declaring `exposes` registers its exposure here, once, with how
// each field presents (a cell, a width) — and every list whose collection
// reaches the exposure's parent entity shows it (data-view's
// `useExposedFields`). The list names no exposure; the exposure names no list.

/** How one exposed field presents in a list — beyond what its exposure declares. */
export interface ExposedFieldPresentation<V> {
  /** The cell, from the field's value; absent ⇒ its type's default cell. */
  cell?: (value: V) => ReactNode;
  width?: string;
  align?: "start" | "end" | "center";
}

/** One exposure, registered with its per-field presentation. */
export interface LiveExposureRegistration<
  R extends Record<string, unknown> = Record<string, unknown>,
> {
  exposure: EntityExposure<R>;
  present?: {
    readonly [K in keyof R & string]?: ExposedFieldPresentation<R[K]>;
  };
}

const ExposureSlot = defineSlot<LiveExposureRegistration>({
  docLabel: (r) => r.exposure.slice,
});

/**
 * The one erasure: `R` ties `present`'s cells to the exposure's values, so it
 * must survive to the call site — the slot stores the erased registration.
 */
function register<R extends Record<string, unknown>>(
  registration: LiveExposureRegistration<R>,
): Contribution {
  return ExposureSlot(registration as unknown as LiveExposureRegistration);
}

/**
 * `LiveExposures.Register({ exposure: shape.exposure, present? })` — the
 * extension's web barrel registers its exposure (`live:exposures-registered`
 * checks it does, beside its server's `LiveColumns.Expose`).
 */
export const LiveExposures = {
  Register: defineSlotFacade(register, ExposureSlot),
};

/** Every registered exposure (data-view folds those a list's collection reaches). */
export function useExposures(): readonly LiveExposureRegistration[] {
  return ExposureSlot.useContributions();
}
