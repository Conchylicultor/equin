import { useCallback } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  sendSiteMessageEndpoint,
  type SiteMessageBody,
  type SiteMessageResponse,
} from "../../core";

/**
 * The contact form's send: posts one message over the subtree's transport and
 * answers `sent` or `rate-limited`. No answer, or a refusal, throws
 * (`TypeError` / `EndpointError`) — the form says so inline.
 *
 * A site takes messages by importing THIS (web) barrel: a composition's closure
 * follows same-runtime imports, so a site that imported only `core` would ship
 * the form without the server half that stores and emails its messages.
 */
export function useSendSiteMessage(): (
  body: SiteMessageBody,
) => Promise<SiteMessageResponse> {
  const fetchEndpoint = useFetchEndpoint();
  return useCallback(
    (body: SiteMessageBody) =>
      fetchEndpoint(sendSiteMessageEndpoint, {}, { body }),
    [fetchEndpoint],
  );
}
