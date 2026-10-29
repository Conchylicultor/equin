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
  if (def.id.startsWith(SCOPE_KEY_PREFIX)) {
    throw new Error(
      `defineCapability: id "${def.id}" starts with "${SCOPE_KEY_PREFIX}", reserved for grant scopes`,
    );
  }
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
 * Who in a mandate's tree a grant covers. A grant with no scope covers every
 * conversation in the tree; a scoped one only:
 *
 * - `root` — the conversation(s) on the mandate's own task (the task the
 *   policy is stated on);
 * - `below` — the conversations on every task under it, not the root's own.
 *
 * So a root can work as an ordinary conversation while what it files runs
 * under stricter (or wider) rules — one mandate, one tree.
 */
export const GRANT_SCOPES = ["root", "below"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

/** A scope's sub-record key in a stored policy. Capability ids cannot start
 * with the prefix ({@link defineCapability}), so the keys never collide. */
const SCOPE_KEY_PREFIX = "@";
export function scopeKey(scope: GrantScope): string {
  return `${SCOPE_KEY_PREFIX}${scope}`;
}

/**
 * The column decoder of a stored policy: a record of capability id → granted
 * value for the whole tree, plus one sub-record per {@link GrantScope} under
 * `@root` / `@below` (same shape) for the scoped grants, branded so the only other spelling of a `MandatePolicy` is
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

/** Grants covering only part of the tree, by {@link GrantScope}. */
export type ScopedGrants = { readonly [S in GrantScope]?: readonly Grant[] };

/**
 * The only way to build a {@link MandatePolicy}: `grants` cover the whole
 * tree, `scoped` the root's own conversation or the tasks below it. Each grant
 * is already parsed by its capability. A capability granted twice where the
 * two would cover one conversation (twice in a list, or whole-tree and scoped)
 * is an authoring error and throws — there is no "last one wins"; granting it
 * once to `root` and once to `below` is two separate grants.
 */
export function mandatePolicy(
  grants: readonly Grant[],
  scoped: ScopedGrants = {},
): MandatePolicy {
  const record: Record<string, unknown> = recordOf(grants, new Set());
  const whole = new Set(Object.keys(record));
  for (const scope of GRANT_SCOPES) {
    const list = scoped[scope];
    if (list !== undefined && list.length > 0) {
      record[scopeKey(scope)] = recordOf(list, whole);
    }
  }
  return MandatePolicySchema.parse(record);
}

function recordOf(
  grants: readonly Grant[],
  whole: ReadonlySet<string>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const g of grants) {
    if (Object.hasOwn(record, g.capId) || whole.has(g.capId)) {
      throw new Error(`mandatePolicy: capability "${g.capId}" granted twice`);
    }
    record[g.capId] = g.value;
  }
  return record;
}
