import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { PlatformTagSchema } from "./platforms";

/**
 * WHY a release is being cut — the one input that decides whether the artifact
 * is shippable.
 *
 * A discriminated union rather than `{ dev?: boolean; platform?: PlatformTag }`,
 * so **"a candidate always names its platform"** is unrepresentable-otherwise at
 * the call site instead of being a rule the argv builder has to remember. The
 * two members map onto exactly two argv shapes:
 *
 * - `staged` → `--dev`, host platform: staged only, never packed, claims no
 *   `latest-<platform>` pointer. This is Studio's existing behaviour, byte for
 *   byte.
 * - `candidate` → `--platform <tag>` and NO `--dev`: it must PACK, or it is not
 *   shippable, and it must be built for the platform the target host reports.
 */
export const ReleaseIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("staged") }),
  z.object({ kind: z.literal("candidate"), platform: PlatformTagSchema }),
]);
export type ReleaseIntent = z.infer<typeof ReleaseIntentSchema>;

/**
 * The intent an omitted `intent` means. Named rather than inlined so the ONE
 * place the omission is resolved (`handleRelease`) and any consumer reasoning
 * about it read the same value.
 */
export const STAGED_INTENT: ReleaseIntent = { kind: "staged" };

// Trigger a local composition release. Mirrors build's `POST /api/build`, but a
// release is parameterized by (composition, target) so the body carries both.
//
// `intent` is optional and means {@link STAGED_INTENT} when absent — so a caller
// that predates candidates (Studio) keeps producing exactly the runs it did
// before, with no edit. It is `.optional()` rather than `.default()` because
// `defineEndpoint` types the client-side body from the schema's OUTPUT type: a
// default would make `intent` a required property for every caller, which is the
// opposite of "the omitted case is byte-identical to today".
export const triggerReleaseEndpoint = defineEndpoint({
  route: "POST /api/release",
  body: z.object({
    composition: z.string(),
    target: z.string(),
    intent: ReleaseIntentSchema.optional(),
  }),
});

// Start a local preview of a finished release artifact (spawns its `launch`).
export const previewEndpoint = defineEndpoint({
  route: "POST /api/release/runs/:id/preview",
});

// Stop a running preview (kills the process group, removes its data dir).
export const stopPreviewEndpoint = defineEndpoint({
  route: "POST /api/release/runs/:id/preview/stop",
});

const ReleaseLogLineSchema = z.object({
  text: z.string(),
  stream: z.enum(["stdout", "stderr"]),
});

export const ReleaseLogsResponseSchema = z.object({
  lines: z.array(ReleaseLogLineSchema),
});

export type ReleaseLogLine = z.infer<typeof ReleaseLogLineSchema>;
export type ReleaseLogsResponse = z.infer<typeof ReleaseLogsResponseSchema>;
