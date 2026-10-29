import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { SshProvider, type SshProviderDescriptor } from "../slots";

export interface ResolvedSshProvider {
  /** The server's console URL, parsed — `null` when absent or unparsable. */
  url: URL | null;
  /** The provider that claims that URL, if any. */
  provider: SshProviderDescriptor | undefined;
}

/**
 * Resolve a server's console URL to a contributed `SshProvider`, if one claims
 * it. The single derivation, because two consumers need the same answer in the
 * same render: the section's header `actions` (which names the provider) and the
 * section body (which renders its console step). Deriving it twice is how the
 * header and the body would come to disagree about which provider a server is
 * on.
 *
 * A `null` url / `undefined` provider is the NORMAL case, not a failure: key
 * setup exists identically for every server, and a matched provider is only
 * decoration on top of it.
 */
export function useSshProvider(server: Server): ResolvedSshProvider {
  const providers = SshProvider.useContributions();
  const raw = server.consoleUrl;
  const url = raw && URL.canParse(raw) ? new URL(raw) : null;
  return {
    url,
    provider: url ? providers.find((p) => p.match(url)) : undefined,
  };
}
