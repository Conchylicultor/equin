import { runClaudePrint } from "@plugins/infra/plugins/claude-cli/server";
import type { PlaceIconPickerImpl } from "../../server/internal/place-icon";
import { buildIconPrompt, SYSTEM_PROMPT } from "./icon-prompt";
import { parseIconAnswer } from "./parse-icon-answer";

/** The computer's icon picker: one Haiku call through the Claude CLI. */
export const haikuIconPicker: PlaceIconPickerImpl = {
  async pick(place, placeId) {
    const out = await runClaudePrint({
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
    const answer = parseIconAnswer(out);
    return answer.ok
      ? { kind: "picked", icon: answer.icon }
      : { kind: "rejected", reason: answer.reason };
  },
};
