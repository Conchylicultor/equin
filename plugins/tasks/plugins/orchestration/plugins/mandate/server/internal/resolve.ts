import { z } from "zod";
import { db } from "@plugins/database/server";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import type { McpToolContext } from "@plugins/infra/plugins/mcp/server";
import {
  getConversation,
  nearestMandate,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  scopeKey,
  type Capability,
  type GrantScope,
  type MandatePolicy,
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

/** A conversation's effective mandate, and where in its tree the
 * conversation sits: on the mandate's own task (`root`) or under it
 * (`below`) — which scoped grants cover it. */
export type ConversationMandate =
  | { kind: "found"; rootTaskId: string; policy: MandatePolicy; at: GrantScope }
  | { kind: "none" };

/** One resolution per conversation at a time: every gated tool's `when` asks
 * on every MCP request, all in parallel. */
const conversationMandates = createInflight();

/** The effective mandate of the task a conversation works on; `none` for a
 * conversation without a task (or that does not exist) — nothing granted. */
export function conversationMandate(
  conversationId: string,
): Promise<ConversationMandate> {
  return conversationMandates.run(conversationId, async () => {
    const conversation = await getConversation(conversationId);
    if (conversation === null) return { kind: "none" } as const;
    const mandate = await mandateOf(conversation.taskId);
    if (mandate.kind === "none") return mandate;
    const at: GrantScope =
      mandate.rootTaskId === conversation.taskId ? "root" : "below";
    return { ...mandate, at };
  });
}

/** What a policy grants for `cap` to a conversation at `at`: the whole-tree
 * grant or the one scoped to `at`, `null` when neither. A stored value the
 * cap's schema refuses throws — a corrupt policy is loud, never "denied" — as
 * does a cap granted both whole-tree and scoped. */
export function grantIn<T>(
  cap: Capability<T>,
  policy: MandatePolicy,
  at: GrantScope,
): T | null {
  const scoped = scopedRecord(policy, at);
  const inWhole = Object.hasOwn(policy, cap.id);
  const inScope = Object.hasOwn(scoped, cap.id);
  if (inWhole && inScope) {
    throw new Error(
      `Mandate grant "${cap.id}" is granted both to the whole tree and to ${scopeKey(at)}`,
    );
  }
  if (!inWhole && !inScope) return null;
  const parsed = cap.schema.safeParse(
    inWhole ? policy[cap.id] : scoped[cap.id],
  );
  if (!parsed.success) {
    throw new Error(
      `Mandate grant "${cap.id}" holds an invalid value: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

const ScopedRecordSchema = z.record(z.string(), z.unknown());

function scopedRecord(
  policy: MandatePolicy,
  at: GrantScope,
): Record<string, unknown> {
  const key = scopeKey(at);
  if (!Object.hasOwn(policy, key)) return {};
  const parsed = ScopedRecordSchema.safeParse(policy[key]);
  if (!parsed.success) {
    throw new Error(
      `Mandate scope "${key}" is not a record of grants: ${parsed.error.message}`,
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
  return mandate.kind === "none"
    ? null
    : grantIn(cap, mandate.policy, mandate.at);
}

/** An `Mcp.tool` `when` gate: the tool is visible only to a conversation whose
 * mandate grants `cap`. */
export function granted<T>(
  cap: Capability<T>,
): (ctx: McpToolContext) => Promise<boolean> {
  return async ({ conversationId }) =>
    (await grantOf(cap, conversationId)) !== null;
}
