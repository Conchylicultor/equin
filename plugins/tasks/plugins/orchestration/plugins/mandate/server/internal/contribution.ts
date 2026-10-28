import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { Capability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * The server half of ONE capability: how a granted value reads to the agent.
 * The plugin that owns the behaviour contributes it next to the tool it gates;
 * the mandate plugin names none.
 */
export interface MandateCapabilityEntry<T> {
  /** The core token — the id and the schema a stored value is parsed by. */
  cap: Capability<T>;
  /** One instruction for the agent, from the granted value. */
  describe: (value: T) => string;
}

const CapabilityToken = defineServerContribution<
  MandateCapabilityEntry<unknown>
>("mandateCapability", { docLabel: (c) => c.cap.id });

/** Erases `T` for storage: the entry is only ever read back through its own
 * `cap.schema`, which restores it. */
function contributeCapability<T>(entry: MandateCapabilityEntry<T>) {
  return CapabilityToken(entry as unknown as MandateCapabilityEntry<unknown>);
}

/** Registers a capability's describe — `Mandate.Capability({ cap, describe })`. */
export const Mandate = {
  Capability: Object.assign(contributeCapability, CapabilityToken),
};

/** Every contributed capability, by id; a second contribution of an id throws. */
export function capabilityEntries(): Map<
  string,
  MandateCapabilityEntry<unknown>
> {
  const byId = new Map<string, MandateCapabilityEntry<unknown>>();
  for (const entry of CapabilityToken.getContributions()) {
    if (byId.has(entry.cap.id)) {
      throw new Error(
        `Mandate capability "${entry.cap.id}" is contributed twice`,
      );
    }
    byId.set(entry.cap.id, entry);
  }
  return byId;
}
