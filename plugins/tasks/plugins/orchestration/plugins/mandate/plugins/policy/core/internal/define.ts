import { z } from "zod";

/**
 * One grant of a capability: the capability's id and a value its own schema
 * already parsed. Minted only by {@link Capability.grant}, so a grant's value
 * is type-correct by construction — the only input {@link mandatePolicy}
 * accepts.
 */
export interface Grant {
  readonly capId: string;
  readonly value: unknown;
}

/**
 * One thing a mandate may grant — a frozen token BOTH the policy author and the
 * enforcing harness import by name. The plugin that owns the behaviour declares
 * it (in its `core/`) and describes it (`Mandate.Capability`, server); the
 * mandate plugin names none.
 */
export interface Capability<T> {
  /** Stable key: the policy record's key, the registry lookup. */
  readonly id: string;
  /** Parses a stored value. JSON-serializable by construction. */
  readonly schema: z.ZodType<T>;
  /** What a person reads in the Debug catalog. */
  readonly label: string;
  /** A grant of this capability with `value` — parsed now, so a bad value
   * throws at the author, not at the agent. */
  grant(value: T): Grant;
}

export interface CapabilityDef<T> {
  id: string;
  schema: z.ZodType<T>;
  label: string;
}

export function defineCapability<T>(def: CapabilityDef<T>): Capability<T> {
  return Object.freeze({
    id: def.id,
    schema: def.schema,
    label: def.label,
    grant(value: T): Grant {
      return Object.freeze({ capId: def.id, value: def.schema.parse(value) });
    },
  });
}

/**
 * The column decoder of a stored policy: a record of capability id → granted
 * value, branded so the only other spelling of a `MandatePolicy` is
 * {@link mandatePolicy}. Each value is parsed by its capability's own schema
 * where it is read (`grantOf`), not here — the mandate plugin names no
 * capability, and a policy stored by newer code may hold one this process does
 * not register.
 */
export const MandatePolicySchema = z
  .record(z.string(), z.unknown())
  .brand<"MandatePolicy">();

/** A policy on a task: what an agent may do inside its subtree. */
export type MandatePolicy = z.infer<typeof MandatePolicySchema>;

/**
 * The only way to build a {@link MandatePolicy}: one entry per grant, each
 * already parsed by its capability. Granting a capability twice is an
 * authoring error and throws — there is no "last one wins".
 */
export function mandatePolicy(grants: readonly Grant[]): MandatePolicy {
  const record: Record<string, unknown> = {};
  for (const g of grants) {
    if (Object.hasOwn(record, g.capId)) {
      throw new Error(`mandatePolicy: capability "${g.capId}" granted twice`);
    }
    record[g.capId] = g.value;
  }
  return MandatePolicySchema.parse(record);
}
