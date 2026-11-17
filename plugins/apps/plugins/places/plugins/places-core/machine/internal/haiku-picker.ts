import { runClaudePrint } from "@plugins/infra/plugins/claude-cli/server";
import { heldAtClaudeLimit } from "@plugins/conversations/plugins/runtime-sdk/machine";
import type { PlaceIconPickerImpl } from "../../server/internal/place-icon";
import { buildIconPrompt, SYSTEM_PROMPT } from "./icon-prompt";
import { parseIconAnswer } from "./parse-icon-answer";

/**
 * The computer's icon picker: one Haiku call through the Claude CLI — in a job,
 * held while the Claude account is at its usage limit (the run sleeps until the
 * reset); in a request (Regenerate), made at once.
 */
export const haikuIconPicker: PlaceIconPickerImpl = {
  async pick(place, placeId, job) {
    const call = () =>
      runClaudePrint({
        tier: "haiku",
        prompt: buildIconPrompt(place),
        system: SYSTEM_PROMPT,
        timeoutMs: 30_000,
        source: {
          name: "places-icon",
          context: { placeId, name: place.name },
          correlationId: placeId,
        },
      });
    const out = await (job ? heldAtClaudeLimit(job, call) : call());
    const answer = parseIconAnswer(out);
    return answer.ok
      ? { kind: "picked", icon: answer.icon }
      : { kind: "rejected", reason: answer.reason };
  },
};
