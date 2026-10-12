import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { runClaudePrint } from "@plugins/infra/plugins/claude-cli/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { placeIdKind } from "../../core";
import { _places } from "./tables";
import { buildIconPrompt, SYSTEM_PROMPT } from "./icon-prompt";
import { parseIconAnswer } from "./parse-icon-answer";

export type GeneratePlaceIconResult =
  | { kind: "written"; icon: SavedSymbolName }
  | { kind: "skipped"; reason: string }
  | { kind: "rejected"; reason: string };

/**
 * Picks one place's map icon with Haiku and writes it back. Shared by the
 * save-triggered job and the Regenerate endpoint (which awaits it in-request).
 *
 * Unforced, it runs only for a place with no icon, and the write is guarded by
 * `icon IS NULL`, so an icon set meanwhile is never replaced. `force`
 * (Regenerate) overwrites. A rejected answer writes nothing: the pin keeps
 * drawing its main tag's icon.
 */
export async function generatePlaceIcon(
  rawPlaceId: string,
  { force = false }: { force?: boolean } = {},
): Promise<GeneratePlaceIconResult> {
  const placeId = placeIdKind.key(rawPlaceId);
  const [place] = await db
    .select({
      name: _places.name,
      primaryType: _places.primaryType,
      types: _places.types,
      address: _places.address,
      icon: _places.icon,
    })
    .from(_places)
    .where(eq(_places.id, placeId));
  if (!place) return { kind: "skipped", reason: "no such place" };
  if (!force && place.icon !== null) {
    return { kind: "skipped", reason: "already has an icon" };
  }

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
  if (!answer.ok) return { kind: "rejected", reason: answer.reason };

  await db
    .update(_places)
    .set({ icon: answer.icon })
    .where(
      force
        ? eq(_places.id, placeId)
        : and(eq(_places.id, placeId), isNull(_places.icon)),
    );
  return { kind: "written", icon: answer.icon };
}

/**
 * The save-triggered run of `generatePlaceIcon`. Keyed on the place, serial (one
 * model call at a time), always unforced — Regenerate awaits the pick in its
 * request instead.
 */
export const placeIconJob = defineJob({
  name: "places.icon.generate",
  description:
    "Asks Claude Haiku to pick a Material Symbols map icon for a saved place from its name, Google type and address.",
  // seconds: one Haiku call bounded by its own 30 s timeout.
  hold: "seconds",
  input: z.object({ placeId: z.string() }),
  event: z.never(),
  dedup: { key: ({ placeId }) => placeId },
  serial: true,
  maxAttempts: 2,
  run: async ({ input: { placeId } }) => {
    const result = await generatePlaceIcon(placeId);
    if (result.kind === "rejected") {
      console.warn(
        `[places-icon] icon for place ${placeId} rejected: ${result.reason}`,
      );
    }
  },
});
