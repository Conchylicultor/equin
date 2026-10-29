import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import type { Server } from "../../shared";
import { ServerHeader } from "../slots";

const serverIcon = symbol("dns");
const terminalIcon = symbol("terminal");

/** The `ssh` invocation that reaches this server, as a person would type it. */
export function sshCommand(server: Server): string {
  return `ssh ${server.port === 22 ? "" : `-p ${server.port} `}${server.sshUser}@${server.host}`;
}

/**
 * The server page's header: the server's mark, name and address (this plugin's
 * own), with the status pill, platform and further buttons contributed through
 * `ServerHeader` by the plugins that own those facts.
 */
export function ServerHeaderBar({ server }: { server: Server }) {
  return (
    <Inset x="md" t="xs" b="sm">
      <Stack direction="row" align="start" gap="md">
        <ServerMark />
        <Fill>
          <ServerIdentity server={server} />
        </Fill>
        <ServerActions server={server} />
      </Stack>
    </Inset>
  );
}

/** The server's mark: its glyph on the same raised tile a site's letter sits on. */
function ServerMark() {
  return (
    <Rigid>
      <Surface level="raised" className="size-11 rounded-lg">
        <Center className="size-full">
          <Icon icon={serverIcon} />
        </Center>
      </Surface>
    </Rigid>
  );
}

function ServerIdentity({ server }: { server: Server }) {
  return (
    <Stack gap="2xs">
      <Inline gap="sm">
        <Text as="h1" variant="title">
          {server.name}
        </Text>
        <ServerHeader.Badge.Render>
          {(part) => <part.component server={server} />}
        </ServerHeader.Badge.Render>
      </Inline>
      <Inline gap="sm">
        <Text as="span" variant="code" tone="muted">
          {server.sshUser}@{server.host}:{server.port}
        </Text>
        <ServerHeader.Meta.Render>
          {(part) => <part.component server={server} />}
        </ServerHeader.Meta.Render>
        {server.consoleUrl && (
          <NewTabButton href={server.consoleUrl} label="Open console" />
        )}
      </Inline>
    </Stack>
  );
}

function ServerActions({ server }: { server: Server }) {
  const { copy, copied } = useCopyToClipboard(sshCommand(server));
  return (
    <Inline gap="sm">
      <Button variant="outline" onClick={copy}>
        <Icon icon={terminalIcon} />
        {copied ? "Copied" : "Copy SSH command"}
      </Button>
      <ServerHeader.Action.Render>
        {(part) => <part.component server={server} />}
      </ServerHeader.Action.Render>
    </Inline>
  );
}
