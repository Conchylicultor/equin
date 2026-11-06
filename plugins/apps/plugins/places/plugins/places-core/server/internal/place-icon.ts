import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { placeIdKind, placeName } from "../../core";
import { _places } from "./tables";

/** What an icon pick reads of a place. */
export interface PlaceIconSubject {
  /** What the user calls the place (`placeName`). */
  name: string;
  /** Google's name, when the user's title differs from it; null otherwise. */
  googleName: string | null;
  /** Null, with `types` empty, for a custom place (no Google place behind it). */
  primaryType: string | null;
  types: readonly string[];
  address: string;
}

export type PlaceIconPick =
  | { kind: "picked"; icon: SavedSymbolName }
  /** The picker answered with no usable icon. */
  | { kind: "rejected"; reason: string }
  /** This host has nothing to pick with (no model): the pin keeps its tag's icon. */
  | { kind: "no-picker"; reason: string };

/**
 * Who picks a place's map icon on this host: Haiku through the computer's
 * Claude CLI (`machine/`), or nobody on a host without one
 * (`places-core/no-icon-picker`), where a place keeps drawing its main tag's
 * icon — the same pin the desktop draws before its pick lands.
 */
export interface PlaceIconPickerImpl {
  pick(place: PlaceIconSubject, placeId: string): Promise<PlaceIconPick>;
}

export const PlaceIconPicker =
  defineHostService<PlaceIconPickerImpl>("places.icon-picker");

export type GeneratePlaceIconResult =
  | { kind: "written"; icon: SavedSymbolName }
  | { kind: "skipped"; reason: string }
  | { kind: "rejected"; reason: string };

/**
 * Picks one place's map icon and writes it back. Shared by the save-triggered
 * job and the Regenerate endpoint (which awaits it in-request).
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
      title: _places.title,
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

  const pick = await PlaceIconPicker.get().pick(
    {
      name: placeName(place),
      googleName: place.title === null ? null : place.name,
      primaryType: place.primaryType,
      types: place.types,
      address: place.address,
    },
    placeId,
  );
  if (pick.kind === "no-picker")
    return { kind: "skipped", reason: pick.reason };
  if (pick.kind === "rejected") return pick;

  await db
    .update(_places)
    .set({ icon: pick.icon })
    .where(
      force
        ? eq(_places.id, placeId)
        : and(eq(_places.id, placeId), isNull(_places.icon)),
    );
  return { kind: "written", icon: pick.icon };
}

/**
 * The save-triggered run of `generatePlaceIcon`. Keyed on the place, serial (one
 * model call at a time), always unforced — Regenerate awaits the pick in its
 * request instead.
 */
export const placeIconJob = defineJob({
  name: "places.icon.generate",
  description:
    "Asks the host's icon picker (Claude Haiku on the computer) to pick a Material Symbols map icon for a saved place from its name (the user's title too), Google type (none for a custom place) and address.",
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
