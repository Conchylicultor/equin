import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

/** Which step of the spawn failed: the workspace's `prepare` (the checkout) or starting the session. */
export const SPAWN_STEPS = ["worktree", "runtime"] as const;
export type SpawnStep = (typeof SPAWN_STEPS)[number];

// The `conversations_ext_spawn_failure` row: the latest failure of a
// conversation's spawn job, written by the job on every failed attempt and
// deleted when a session starts. Its presence is the positive fact "this
// launch failed" — a `gone` row without a session id is NOT that fact (an
// adopted session that ended has none either, and it did run).
export const spawnFailureShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    step: enumTextField(SPAWN_STEPS),
    message: textField(),
    failedAt: dateField(),
  },
});
export const SpawnFailureSchema = spawnFailureShape.schema;
export type SpawnFailure = z.infer<typeof SpawnFailureSchema>;

// A conversation's spawn failure, read by the conversation's id — lookup-only
// (nothing lists every failure): `useLiveRow` for one conversation,
// `useLive(c, { ids })` for a list's `gone` rows. `found: false` is "no
// failure". A load is a primary-key seek over the asked ids, and a write
// routes to the tuples naming that conversation alone.
export const spawnFailureRows = liveCollection("conversation-spawn-failures", {
  from: spawnFailureShape,
  id: "conversationId",
});
