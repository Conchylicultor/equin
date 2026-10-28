import type { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  RewindPreviewSchema,
  RewindRefusalSchema,
} from "@plugins/conversations/core";

/** Both the preview and the rewind read the agent's transcript off the computer. */
export const REWINDING = { feature: "Rewinding a conversation" } as const;

/** What going back to a message keeps and loses — the preview's answer. */
export const RewindCutPreviewSchema = RewindPreviewSchema.options[0].omit({
  ok: true,
});
export type RewindCutPreview = z.infer<typeof RewindCutPreviewSchema>;

/**
 * What going back to message `uuid` of conversation `id` would keep and lose.
 * Reads only, and computed by the same cut the rewind and the fork perform — so
 * the dialog the user confirms cannot describe a different cut than the one
 * that then happens.
 *
 * Read by the Rewind / Fork action with `useLiveReader` at the click: a
 * snapshot, measured when asked (the transcript moves with every turn, and
 * nothing but the click wants the answer).
 *
 * A message that cannot be gone back to is a refusal carrying the rewind's own
 * reason and a sentence to show (`RewindRefusalSchema`): a message no longer
 * in the transcript, a conversation with no transcript on
 * disk.
 */
export const rewindPreview = liveValue("conversations.rewind-preview", {
  schema: RewindCutPreviewSchema,
  params: ["id", "uuid"],
  refusals: RewindRefusalSchema,
  load: "snapshot",
  needsMachine: REWINDING,
});
