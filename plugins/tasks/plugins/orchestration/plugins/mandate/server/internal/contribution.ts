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
 * A claim on who owns a task, made by a plugin whose workflow gives tasks an
 * owner the folder tree does not show (a supervisor role owns its backlog and
 * its session trees). Ownership decides who may manage a task (`edit_task` /
 * `drop_task`) and whose leftovers block an exit: the tasks plugin resolves a
 * task's owner from these claims first, then from the tree and the task's
 * filer. The mandate plugin names no claimant.
 */
export interface TaskOwnerClaimEntry {
  /** Unique (diagnostics). */
  id: string;
  /** The owner `taskId` has under this claim, or `null` when the claim says
   * nothing about it. */
  claim: (taskId: string) => Promise<ClaimedOwner | null>;
}

/** An owner a claim names: who it is in words (a refusal names it), and
 * whether a conversation acts as it. */
export interface ClaimedOwner {
  /** "supervisor role Follow ups". */
  label: string;
  owns: (conversationId: string) => Promise<boolean>;
}

const OwnerClaimToken = defineServerContribution<TaskOwnerClaimEntry>(
  "taskOwnerClaim",
  { docLabel: (c) => c.id },
);

/** Registers an ownership claim — `TaskOwnerClaim({ id, claim })`. */
export const TaskOwnerClaim = OwnerClaimToken;

/** The owner the first contributed claim names for `taskId`; `null` when no
 * claim speaks for it. Two claims naming an owner for one task is a broken
 * invariant (two workflows think they own it) and throws. */
export async function claimedOwnerOf(
  taskId: string,
): Promise<ClaimedOwner | null> {
  let found: { id: string; owner: ClaimedOwner } | null = null;
  for (const entry of OwnerClaimToken.getContributions()) {
    const owner = await entry.claim(taskId);
    if (owner === null) continue;
    if (found !== null)
      throw new Error(
        `Task ${taskId} is claimed by both "${found.id}" and "${entry.id}" (TaskOwnerClaim)`,
      );
    found = { id: entry.id, owner };
  }
  return found?.owner ?? null;
}
