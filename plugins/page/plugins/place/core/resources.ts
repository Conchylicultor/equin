import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { ResourceRefusal } from "@plugins/packages/plugins/resource-protocol/core";
import { PlaceSnapshotSchema, PlaceSuggestionSchema } from "./schemas";

/**
 * Why a place lookup (search or resolve) can be refused — a determinate answer
 * the block shows, never reported as a server failure:
 *
 * - `unknown-provider` — no provider is registered under `providerId`;
 * - `not-configured` — the provider is not set up yet (no credential): the
 *   search box shows the message beside the provider's own `AccessAction`;
 * - `not-found` — the provider does not know this `placeId` (resolve).
 *
 * A provider refusing requests for now (a quota or rate limit) is a failure,
 * not a refusal: it passes, so the read's error offers Retry.
 */
export const PLACE_LOOKUP_REFUSALS = [
  "unknown-provider",
  "not-configured",
  "not-found",
] as const;
export type PlaceLookupRefusalCode = (typeof PLACE_LOOKUP_REFUSALS)[number];

/**
 * The refusal a provider throws for one of {@link PLACE_LOOKUP_REFUSALS} — both
 * lookup values declare the same codes, so a provider says it once whichever
 * question it was asked. Any other failure stays a plain Error.
 */
export class PlaceLookupRefusal extends ResourceRefusal {
  constructor(code: PlaceLookupRefusalCode, message: string) {
    super(code, message);
    this.name = "PlaceLookupRefusal";
  }
}

/**
 * Type-ahead lookup, keyed by `(providerId, q, session)`. `providerId` selects
 * the registered provider; the value itself knows no provider and reads no
 * credential.
 *
 * `session` is a per-search-round token minted by the client and passed to
 * BOTH lookups, so a provider that bills a search-then-pick as one session can
 * say which suggestions the resolve belongs to. Opaque here — this plugin only
 * carries it.
 *
 * Bounded: the answer is one provider round — Google's autocomplete answers at
 * most 5 suggestions — never a paged list. It is an OBJECT, not a bare array:
 * a suggestion list is a thing that will grow attributes (a "more results"
 * cursor, a per-round notice), and an array has nowhere to put them.
 *
 * On-demand: a third-party answer nothing pushes a change to; a new question is
 * a new tuple.
 */
export const placeSearch = liveValue("place.search", {
  schema: z.object({ suggestions: z.array(PlaceSuggestionSchema) }),
  params: ["providerId", "q", "session"],
  refusals: PLACE_LOOKUP_REFUSALS,
  load: "on-demand",
});

/**
 * One chosen suggestion turned into the snapshot the block stores, keyed by
 * `(providerId, placeId, session)`. The block copies the answer into its data
 * and stops reading; the session rotates after every resolve, so a later
 * refresh is a new question.
 */
export const placeResolve = liveValue("place.resolve", {
  schema: PlaceSnapshotSchema,
  params: ["providerId", "placeId", "session"],
  refusals: PLACE_LOOKUP_REFUSALS,
  load: "on-demand",
});
