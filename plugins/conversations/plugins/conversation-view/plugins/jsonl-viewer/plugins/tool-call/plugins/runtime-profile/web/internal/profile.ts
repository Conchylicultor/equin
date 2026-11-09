import { z } from "zod";
import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";

const InputSchema = z.object({
  kind: z.string().optional(),
  limit: z.number().optional(),
  worktree: z.string().optional(),
});

const AggregateSchema = z.object({
  label: z.string(),
  count: z.number(),
  avgMs: z.number(),
  waitMs: z.number().optional(),
  selfMs: z.number().optional(),
  maxMs: z.number(),
  recentMaxMs: z.number(),
});
export type Aggregate = z.infer<typeof AggregateSchema>;

const GateSchema = z.object({ totalMs: z.number() }).passthrough();

const ProfileSchema = z.object({
  sinceMs: z.number().optional(),
  kinds: z.record(
    z.string(),
    z.object({ aggregates: z.array(AggregateSchema) }).passthrough(),
  ),
  gates: z.array(GateSchema).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export function readProfileInput(event: ToolCallEvent) {
  return InputSchema.parse(event.input ?? {});
}

export type ProfileRead =
  { kind: "profile"; profile: Profile } | { kind: "text"; text: string };

/** The result is the tool's JSON; anything else (an error message) is shown as text. */
export function readProfile(content: string): ProfileRead {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) return { kind: "text", text: content };
    throw err;
  }
  const parsed = ProfileSchema.safeParse(json);
  return parsed.success
    ? { kind: "profile", profile: parsed.data }
    : { kind: "text", text: content };
}

export function describeProfileInput(
  i: ReturnType<typeof readProfileInput>,
): string {
  const parts = [i.worktree ?? "this worktree", i.kind ?? "all kinds"];
  if (i.limit !== undefined) parts.push(`top ${i.limit}`);
  return parts.join(" · ");
}
