import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  Steps,
  Step,
  StepLink,
  type StepState,
} from "@plugins/primitives/plugins/setup-steps/web";
import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import {
  useServerVerified,
  VerifyConnectionBody,
} from "@plugins/apps/plugins/deploy/plugins/health/web";
import { useSshProvider } from "../internal/use-ssh-provider";
import { GenerateKeyStep } from "./generate-key-step";
import { InstallKeyStep } from "./install-key-step";

/**
 * The SSH-setup section of a server page — the BODY only. The card, its title,
 * its chevron and its open state belong to the `ServerDetail` host, so this
 * section cannot drift from its peers on any of them; what the contribution
 * declares beside this component is the header (`label`, `icon`, `actions`) and
 * the seed for the open state (`useDefaultOpen: () => !verified` — expanded
 * while action is needed, collapsed to one row once the connection is proven).
 *
 * It **always renders**: key setup is the collection's job, and a matched
 * provider is decoration (a chip in the header, console prose in a step) on top
 * of it. It used to bail out when the console URL was empty, unparsable, or
 * matched no provider — which left exactly those servers with no way to set a
 * key at all.
 *
 * Two facts, two owners, both rendered exactly once: the **fingerprint** (what
 * key we hold) lives in the header `actions` (`SshSetupActions`), and the
 * **verdict** (whether that key works) lives in the last step, owned by
 * `health`. The header is the one region visible both collapsed and expanded, so
 * it is the real status line; a step that reprinted the fingerprint would
 * recreate the two-places-disagree bug at a new pair of locations.
 *
 * Loading until the verdict lands: every step after the key takes its state
 * from it, and "active" shown for a server already proven would ask the user
 * to redo work that is done. A verdict that could not be read says so, with
 * Retry, rather than guessing the steps' states.
 */
export function SshSetupSection({ server }: { server: Server }) {
  const verification = useServerVerified(server);
  const { url, provider } = useSshProvider(server);
  if (verification.status === "loading") return <Loading variant="rows" />;
  if (verification.status === "error")
    return (
      <ResourceErrorInline
        variant="block"
        subject="the connection verdict"
        error={verification.error}
        refetch={verification.refetch}
      />
    );
  const verified = verification.data;

  const key = server.sshKey;
  const ConsoleInstructions = provider?.ConsoleInstructions;

  // Every step after the key shares one state: inert until we hold a key,
  // actionable until the probe succeeds, done after. They gate on the same
  // fact because they need the same thing — a key we can name AND dial with,
  // which is exactly `sshKey !== null`. A stored key we could not parse is not
  // installable (no line to copy) and not testable unattended, so it stays
  // `upcoming` rather than offering steps that can only fail.
  const afterKeyState: StepState = !key
    ? "upcoming"
    : verified
      ? "done"
      : "active";

  return (
    /* The collection owns every <Step> shell — `Steps` injects number/isLast
       onto its direct children, so a provider returning a <Step> would leak
       that protocol across a plugin boundary and break numbering. A provider
       supplies a step BODY. `{url && <Step/>}` composes correctly:
       Children.toArray drops `false`, so with no console URL the steps are
       simply numbered 1, 2, 3. */
    <Steps>
      <Step title="Create an SSH key" state={key ? "done" : "active"}>
        <GenerateKeyStep server={server} />
      </Step>

      {url && (
        <Step
          title={
            provider ? `Open the ${provider.name} console` : "Open the console"
          }
          state={afterKeyState}
        >
          <Stack gap="sm" align="start">
            {ConsoleInstructions && (
              <ConsoleInstructions sshUser={server.sshUser} />
            )}
            <StepLink href={url.href} label="Open console" />
          </Stack>
        </Step>
      )}

      <Step title="Install the public key" state={afterKeyState}>
        <InstallKeyStep sshKey={key} />
      </Step>

      <Step title="Verify the connection" state={afterKeyState}>
        <VerifyConnectionBody server={server} />
      </Step>
    </Steps>
  );
}
