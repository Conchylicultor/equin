import { db } from "@plugins/database/server";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import type { McpToolContext } from "@plugins/infra/plugins/mcp/server";
import {
  getConversation,
  nearestMandate,
} from "@plugins/tasks/plugins/tasks-core/server";
import type {
  Capability,
  MandatePolicy,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/** A task's effective mandate, or `none` when nothing covers it. */
export type EffectiveMandate =
  | { kind: "found"; rootTaskId: string; policy: MandatePolicy }
  | { kind: "none" };

/**
 * A task's effective mandate: the policy on the nearest task up its folder
 * chain (itself included) — nearest wins. With every root carrying one (the
 * `tasks_root_has_mandate` CHECK), `none` means the task does not exist.
 */
export async function mandateOf(taskId: string): Promise<EffectiveMandate> {
  return nearestMandate(taskId, db);
}

/** One resolution per conversation at a time: every gated tool's `when` asks
 * on every MCP request, all in parallel. */
const conversationMandates = createInflight();

/** The effective mandate of the task a conversation works on; `none` for a
 * conversation without a task (or that does not exist) — nothing granted. */
export function conversationMandate(
  conversationId: string,
): Promise<EffectiveMandate> {
  return conversationMandates.run(conversationId, async () => {
    const conversation = await getConversation(conversationId);
    if (conversation === null) return { kind: "none" } as const;
    return mandateOf(conversation.taskId);
  });
}

/** What a policy grants for `cap`: `null` when not granted; a stored value
 * the cap's schema refuses throws — a corrupt policy is loud, never "denied". */
export function grantIn<T>(
  cap: Capability<T>,
  policy: MandatePolicy,
): T | null {
  if (!Object.hasOwn(policy, cap.id)) return null;
  const parsed = cap.schema.safeParse(policy[cap.id]);
  if (!parsed.success) {
    throw new Error(
      `Mandate grant "${cap.id}" holds an invalid value: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * What the conversation's mandate grants for `cap` — its parsed value, or
 * `null` when the mandate does not grant it (or nothing covers the
 * conversation). An invalid stored value throws.
 */
export async function grantOf<T>(
  cap: Capability<T>,
  conversationId: string,
): Promise<T | null> {
  const mandate = await conversationMandate(conversationId);
  return mandate.kind === "none" ? null : grantIn(cap, mandate.policy);
}

/** An `Mcp.tool` `when` gate: the tool is visible only to a conversation whose
 * mandate grants `cap`. */
export function granted<T>(
  cap: Capability<T>,
): (ctx: McpToolContext) => Promise<boolean> {
  return async ({ conversationId }) =>
    (await grantOf(cap, conversationId)) !== null;
}
