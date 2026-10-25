import { z } from "zod";
import { compileLookup } from "@plugins/infra/plugins/query-resource/server";
import { _conversations } from "./tables";

// Which runtime hosts a conversation, and where its turn stands — a compiled
// lookup (query-resource's `compileLookup`), so a value loader that asks the
// conversation's agent something declares exactly what that read reads
// (`read(keyOf)` in its `reads.lookups`): a `conversations` write reaches only
// the tuple asking about the row it touched, and only when it moved a column
// the lookup reads (`id`, `runtime`, `status`). Every other conversation's
// writes, and this one's `waiting_for` / `last_viewed_at` / `working_on` /
// hibernation moves, reach no reader. `status` is read because it is the
// row's turn signal: it moves when a turn starts and ends.

/** A conversation's runtime row, as this lookup reads it. */
const RuntimeRowSchema = z.object({
  runtime: z.string(),
  status: z.string(),
});

/** The runtime and turn status of a conversation, by the conversation's id. */
export const runtimeOfConversationLookup = compileLookup({
  label: "tasks-core.runtime-of-conversation",
  from: _conversations,
  by: _conversations.id,
  select: {
    runtime: { from: "base", col: _conversations.runtime },
    status: { from: "base", col: _conversations.status },
  },
  row: RuntimeRowSchema,
});
