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
  /**
   * The agent's Mandate line for the granted value, or `null` for none.
   *
   * Write a line ONLY for what nothing else tells the agent. A capability that
   * just gates a tool says nothing here: the tool appears only when granted,
   * and its own description states its limits. A value that matches what
   * CLAUDE.md already says (push only when asked) says nothing either. What is
   * left is behaviour no tool carries — how to pace itself while it watches,
   * that it may push or close on its own.
   */
  describe: (value: T) => string | null;
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

/**
 * A mandate's reach beyond its own tree: whether the conversation may manage
 * (edit, drop, depend on) `taskId` although the task is not under its
 * mandate's root. Contributed by the plugin whose workflow widens the scope
 * (a predicate on tasks it owns); the mandate plugin names none, and the
 * caller's own root stays out of reach whatever a predicate says.
 */
export interface MandateReachEntry {
  /** Unique (diagnostics). */
  id: string;
  reaches: (conversationId: string, taskId: string) => Promise<boolean>;
}

const ReachToken = defineServerContribution<MandateReachEntry>("mandateReach", {
  docLabel: (r) => r.id,
});

/** Registers a reach predicate — `MandateReach({ id, reaches })`. */
export const MandateReach = ReachToken;

/** Whether any contributed reach lets `conversationId` manage `taskId`
 * outside its own tree. */
export async function reachesBeyondTree(
  conversationId: string,
  taskId: string,
): Promise<boolean> {
  for (const entry of ReachToken.getContributions()) {
    if (await entry.reaches(conversationId, taskId)) return true;
  }
  return false;
}
