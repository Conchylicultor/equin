import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

// Where this week's Claude spend went, as one drill tree: the four categories
// (Supervisors, Ad hoc, Background, You), each opening into the next level.
// Amounts are API-equivalent dollars, read off the priced usage ledger
// (`claude_spend_hours_v`, infra/claude-cli/usage-ledger/pricing).

/** The tree's root id — the first part of every drill path. */
export const SPEND_ROOT_ID = "week";

/**
 * The four categories, in the order every surface draws them (the glance's
 * legend, the root level's rows), each with the short name the glance's
 * legend uses. A closed list: classification is the server's, the names are
 * both runtimes'.
 */
export const SPEND_CATEGORIES = [
  { id: "supervisors", name: "Supervisors", short: "Supervisors" },
  { id: "adhoc", name: "Ad-hoc supervisors", short: "Ad hoc" },
  { id: "background", name: "Background", short: "Background" },
  { id: "you", name: "Your conversations", short: "You" },
] as const;
export type SpendCategoryId = (typeof SPEND_CATEGORIES)[number]["id"];

/** Each level shows its five biggest parts, the rest folded into one node. */
export const SPEND_TOP_PARTS = 5;

/** What a node stands for. `rest` folds a level's smaller parts. */
export const SPEND_NODE_KINDS = [
  "root",
  "category",
  "role",
  "session",
  "task",
  "attempt",
  "conversation",
  "automation",
  "caller",
  "rest",
] as const;
export type SpendNodeKind = (typeof SPEND_NODE_KINDS)[number];

export interface SpendNode {
  /** Unique among its siblings — one part of a drill path. */
  id: string;
  kind: SpendNodeKind;
  /**
   * Its name. An `automation` node's is the automation's id — its label is
   * the automations catalog's, read where it is drawn.
   */
  name: string;
  /** A shorter name, where one exists (a category's, in the glance legend). */
  short: string | null;
  /** One line under the name: what it holds ("3 workers", "2 attempts"). */
  sub: string | null;
  /** What it spent in the windows, at API prices. */
  costUsd: number;
  /** The part of `costUsd` spent on API-key accounts — billed, not quota. */
  billedUsd: number;
  /** A conversation under it is running now. */
  live: boolean;
  /** The conversation it opens — a conversation leaf's, else `null`. */
  conversationId: string | null;
  /** How many parts a `rest` node folds, else `null`. */
  count: number | null;
  /** Its parts: the biggest five, then one `rest`. Empty for a leaf. */
  children: SpendNode[];
}

const SpendNodeSchema: z.ZodType<SpendNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: z.enum(SPEND_NODE_KINDS),
    name: z.string(),
    short: z.string().nullable(),
    sub: z.string().nullable(),
    costUsd: z.number(),
    billedUsd: z.number(),
    live: z.boolean(),
    conversationId: z.string().nullable(),
    count: z.number().int().nullable(),
    children: cappedList(SpendNodeSchema, { max: SPEND_TOP_PARTS + 1 }),
  }),
);

/** An ISO instant (`Date.prototype.toISOString`), checked, never rewritten. */
const InstantSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO instant");

/**
 * One account's window: its spend counts from `since`. `metered` marks an
 * API-key account (billed per use, no weekly quota).
 */
export const SpendWindowSchema = z.object({
  accountId: z.string().min(1),
  since: InstantSchema,
  metered: z.boolean(),
});
export type SpendWindow = z.infer<typeof SpendWindowSchema>;

/** The most accounts one read names — every account signed in, a handful. */
export const SPEND_WINDOWS_MAX = 16;

/**
 * The question: one window per account, in account-id order (the browser
 * builds them — a served read never reads the clock).
 */
export const SpendQuerySchema = z.object({
  windows: cappedList(SpendWindowSchema, { max: SPEND_WINDOWS_MAX }),
});
export type SpendQuery = z.infer<typeof SpendQuerySchema>;

export const SpendBreakdownSchema = z.object({
  tree: SpendNodeSchema,
  /**
   * The first hour the ledger attributed spend to what spent it (ISO), on
   * any of the asked accounts — spend before it carries no source and is not
   * in the tree. `null` when nothing is attributed yet.
   */
  attributedSince: InstantSchema.nullable(),
});
export type SpendBreakdown = z.infer<typeof SpendBreakdownSchema>;

/**
 * This week's spend, as the drill tree: each account counted over its own
 * window (a plan account from its last weekly reset, an API-key account over
 * the last 7 days). Pushed on every write to the spend ledger.
 *
 * BOUND: every level is its five biggest parts and one rest (`cappedList`
 * max 6), five levels deep at most.
 */
export const supervisorsSpend = liveValue("supervisors.spend", {
  schema: SpendBreakdownSchema,
  query: SpendQuerySchema,
});
