import {
  transportScoped,
  useTransportScoped,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { liveStateSocketUrl } from "@plugins/primitives/plugins/live-state/web";
import { BlockDocs } from "./collab-session";

/**
 * One content-doc registry per transport: its server-synced docs seed and
 * flush over that transport's endpoint client, and resume when that
 * transport's live-state socket reopens.
 */
const blockDocsOf = transportScoped((transport) => {
  const fetchEndpoint = fetchEndpointOver(transport);
  return new BlockDocs({
    fetchEndpoint,
    socketUrl: liveStateSocketUrl(transport, "worktree"),
  });
});

/** `transport`'s content-doc registry — the one its editors' `useBlockDocs()` reads. */
export function blockDocsFor(transport: Transport): BlockDocs {
  return blockDocsOf.of(transport);
}

/** The content-doc registry of the enclosing subtree's transport. */
export function useBlockDocs(): BlockDocs {
  return useTransportScoped(blockDocsOf);
}
