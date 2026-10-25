import { implement } from "@plugins/infra/plugins/endpoints/server";
import { serveStatusEndpoint } from "../../shared/endpoints";
import { readServeStatus } from "./serve-status";

/**
 * The serve status over HTTP — kept for the local-serve e2e script
 * (`apps/deploy/local-serve/e2e/local-serve-verify.ts`), which asks it from
 * outside the app. The app itself reads the `build.serve-status` live value.
 */
export const handleServeStatus = implement(serveStatusEndpoint, ({ query }) =>
  readServeStatus(query.composition),
);
