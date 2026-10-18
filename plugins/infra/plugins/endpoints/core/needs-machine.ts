/**
 * A desktop-only feature: what a declaration that needs the computer (an
 * endpoint or a live read declared `needsMachine`) is called in the sentence a
 * host without the computer shows instead of it — "Launching an agent".
 */
export interface MachineFeature {
  readonly feature: string;
}

/**
 * The one sentence a host without the computer answers a `needsMachine`
 * declaration with, composed here so every surface says it the same way.
 */
export function unavailableMessage(feature: MachineFeature): string {
  return `${feature.feature} isn't available in this version of the app — it needs Singularity running on your computer.`;
}

/** The answer a `needsMachine` declaration gets on a host without the computer. */
export interface MachineUnavailable {
  kind: "unavailable";
  message: string;
}

/**
 * What a `needsMachine` endpoint answers: its value, or the unavailable arm —
 * a type, so a caller cannot read the value without first handling the arm.
 */
export type MachineResult<T> = { kind: "ok"; value: T } | MachineUnavailable;

/** Whether this subtree's host has the computer, for gating UI before a click. */
export type MachineAvailability =
  { available: true } | { available: false; message: string };
