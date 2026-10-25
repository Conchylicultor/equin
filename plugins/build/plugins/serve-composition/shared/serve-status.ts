import { liveValue } from "@plugins/network/plugins/live/core";
import { ServeStatusResponseSchema } from "./endpoints";

const SERVE_STATUS_REFUSALS = ["invalid-composition"] as const;

/**
 * Where is a composition served from the answering backend's checkout, and is
 * anything actually there right now? The same answer as `serveStatusEndpoint`
 * (kept for the local-serve e2e script), read live: the backend watches the
 * namespace's `composition.json` marker for as long as a tuple is read, so a
 * serve build landing its marker — or a reclaim removing the namespace — is
 * pushed rather than refetched on a guess.
 *
 * `composition` is the manifest item's **id**, one LABEL of a namespace; an id
 * that is not one is refused `invalid-composition` (a malformed question, not a
 * server failure).
 *
 * Desktop-only: the marker is a file on the computer.
 */
export const serveStatus = liveValue("build.serve-status", {
  schema: ServeStatusResponseSchema,
  params: ["composition"],
  refusals: SERVE_STATUS_REFUSALS,
  needsMachine: { feature: "Reading what is served locally" },
});
