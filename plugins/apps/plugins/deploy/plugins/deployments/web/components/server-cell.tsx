import type { ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  serverDetailPane,
  servers,
} from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { SiteProps } from "../slots";

const serverIcon = symbol("dns");

/**
 * The production strip's Server cell: the server the site runs on, opening its
 * page. This plugin's own (not `health`'s): `deployments` already reads
 * `health`, so `health` contributing here would close a cycle.
 */
export function ServerCell({ deployment }: SiteProps): ReactNode {
  const list = useLive(servers);
  const openPane = useOpenPane();
  if (list.status === "loading") return <Loading />;
  if (list.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the server"
        error={list.error}
        refetch={list.refetch}
      />
    );
  }
  const server = list.data.find((s) => s.id === deployment.serverId);
  return (
    // `aspect="inline"` sizes the link at 1em: the label text around it is
    // what sets it to the strip's value size.
    <Text as="span" variant="label">
      <Button
        variant="ghost"
        aspect="inline"
        {...openPane.link(
          serverDetailPane,
          { serverId: deployment.serverId },
          { mode: "root" },
        )}
      >
        <Icon icon={serverIcon} />
        {server?.name ?? deployment.serverId}
      </Button>
    </Text>
  );
}
