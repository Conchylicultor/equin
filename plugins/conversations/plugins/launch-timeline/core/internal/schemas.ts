import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { nullable } from "@plugins/fields/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { LAUNCH_PHASE_IDS } from "./phases";

/** Each phase's instant (epoch ms), present once reached. */
export const LaunchMarksSchema = z.partialRecord(
  z.enum(LAUNCH_PHASE_IDS),
  z.number(),
);
export type LaunchMarks = z.infer<typeof LaunchMarksSchema>;

/**
 * At most this many checkout steps are kept: one checkout takes about ten
 * (infra/worktree's `SetupStepName`, a few twice).
 */
export const MAX_CHECKOUT_STEPS = 32;

/**
 * One step of the checkout child's `setupWorktree` — the same spans its
 * `worktree-prepare` log lines carry (infra/worktree's `SetupStep`), with the
 * instant it ended so it can be placed on the launch's axis.
 */
export const CheckoutStepSchema = z.object({
  step: z.string(),
  ms: z.number(),
  endAt: z.number(),
  failed: z.literal(true).optional(),
});
export type CheckoutStep = z.infer<typeof CheckoutStepSchema>;

/**
 * How the checkout was made: a claimed `spare` (warm), a `fresh` add (cold),
 * or an `existing` one re-locked and installed (a resume). Null until the
 * checkout child ends, and for a workspace with no checkout (scratch).
 */
export const CHECKOUT_SOURCES = ["spare", "fresh", "existing"] as const;
export type CheckoutSourceKind = (typeof CHECKOUT_SOURCES)[number];

// The `conversations_ext_launch` row: one per launch of a conversation's agent
// by its spawn job — from the request (the conversation's creation) to the
// first streamed token and the first complete message. Opened by the spawn
// job, filled by the checkout child (its boot, every step, its end) and by the
// agent's own events (started, ready, first token, first message). Every mark
// is first-wins: a retried spawn keeps the instants its first run reached.
export const launchShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    attemptId: textField(),
    requestedAt: dateField(),
    marks: jsonField({ schema: LaunchMarksSchema, default: {} }),
    checkoutSteps: jsonField({
      schema: cappedList(CheckoutStepSchema, { max: MAX_CHECKOUT_STEPS }),
      default: [],
    }),
    checkoutSource: nullable(enumTextField(CHECKOUT_SOURCES)),
    /**
     * The launch's agent process (its `started` pid): only that process's
     * later events mark the launch, never a resume's days later.
     */
    agentPid: nullable(intField()),
    /**
     * The spawn gave up before its agent started (dead-lettered, or Claude
     * Code missing): no later process — a resume — claims the record.
     */
    abandonedAt: nullable(dateField()),
  },
  serverOnly: ["agentPid"],
});
export type LaunchRecord = z.infer<typeof launchShape.schema>;

// The newest launches, for the Profiling section's per-phase p50 / p90.
export const conversationLaunches = liveCollection("conversations.launches", {
  from: launchShape,
  id: "conversationId",
  sortable: ["requestedAt"],
  default: { orderBy: [["requestedAt", "desc"]], limit: 200 },
  maxLimit: 1000,
});
