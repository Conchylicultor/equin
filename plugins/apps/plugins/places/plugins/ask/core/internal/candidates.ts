import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { PlaceCandidateSchema } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";

/** Every Google candidate a run's searches returned, by place id. */
export const AskCandidatesSchema = z.record(z.string(), PlaceCandidateSchema);

// The `conversations_ext_places_ask` row: the Google candidates an Ask Sonnet
// run's searches returned, by place id — merged on every search, never
// replaced. It is what a pick's card is drawn from (a pick names only an id),
// and what the picks tool checks an id against.
export const askCandidatesShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    candidates: jsonField({ schema: AskCandidatesSchema, default: {} }),
  },
});

// One run's candidates, read by its conversation id — lookup-only:
// `useLiveRow(askCandidates, conversationId)`, `found: false` before its first
// search. A search's write routes to that conversation's readers alone.
export const askCandidates = liveCollection("places.ask.candidates", {
  from: askCandidatesShape,
  id: "conversationId",
});
