import { z } from "zod";

/** `get_runtime_profile`'s input, as its card draws it: every field is optional. */
export const ProfileInputSchema = z.looseObject({
  kind: z.string().optional(),
  limit: z.number().optional(),
  worktree: z.string().optional(),
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

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

export function describeProfileInput(i: ProfileInput): string {
  const parts = [i.worktree ?? "this worktree", i.kind ?? "all kinds"];
  if (i.limit !== undefined) parts.push(`top ${i.limit}`);
  return parts.join(" · ");
}
