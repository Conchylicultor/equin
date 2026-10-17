import { Icon } from "@plugins/ui/plugins/icons/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { useSshProvider } from "../internal/use-ssh-provider";

/**
 * The SSH section's header-right controls — the one region visible both
 * collapsed and expanded, i.e. the section's real status line.
 *
 * It carries the two things a collapsed card must still answer:
 *
 * - **Which provider this server is on**, as a chip. The provider is a property
 *   of the *server*, not of the section, so it cannot live in the section's
 *   static `label`; a chip beside the title says the same thing without the
 *   title changing identity per row.
 * - **Which key we hold**, as its SHA256 fingerprint (or `No key`). Rendered
 *   exactly ONCE in the whole section: no step reprints it. Two places showing
 *   key state is the bug this section exists to have fixed. The *verdict* —
 *   whether that key works — is a different fact with a different owner, and
 *   lives in the last step (`health`'s `VerifyConnectionBody`).
 */
export function SshSetupActions({ server }: { server: Server }) {
  const { provider } = useSshProvider(server);
  const ProviderIcon = provider?.icon;
  const key = server.sshKey;

  return (
    <Inline gap="xs">
      {provider && (
        <Badge icon={ProviderIcon ? <Icon icon={ProviderIcon} /> : undefined}>
          {provider.name}
        </Badge>
      )}
      {key ? (
        <>
          <Badge mono tooltip={key.fingerprint} className="max-w-[16rem]">
            {key.fingerprint}
          </Badge>
          <CopyButton text={key.fingerprint} tooltip="Copy fingerprint" />
        </>
      ) : (
        <Badge variant="warning">No key</Badge>
      )}
    </Inline>
  );
}
