import type { ReactNode } from "react";
import { useDeploymentShips } from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { MirrorFreshness } from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/web";
import { SITE_MESSAGES_MIRROR_SET_ID } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import {
  SITE_CARD_LIST_TOOLBAR,
  SiteCard,
  SiteCardBody,
  useSiteTabLink,
  type SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
} from "@plugins/primitives/plugins/data-view/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { siteMessagesInbox, type SiteMessageRow } from "../../core";
import { INTAKE_PLUGIN_ID } from "../internal/intake-plugin-id";
import { firstLine } from "../internal/present";
import { useMessagesCopy } from "../internal/use-messages-copy";
import { MESSAGES_SUBJECT } from "./messages-section";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MESSAGES_CARD_VIEW = defineDataView("deploy.site-messages.overview");

const chevronIcon = symbol("chevron-right");

/** How many messages the Overview shows. */
const NEWEST = 3;

// The card draws its own line per message (`renderRow`); the fields are the
// collection's, the message on one line.
const overrides = fieldOverrides(siteMessagesInbox, {
  message: { cell: (m) => firstLine(m.message) },
});

function InboxLink(): ReactNode {
  const link = useSiteTabLink("messages");
  return (
    <Button variant="ghost" {...linkProps(link)}>
      Inbox
      <Icon icon={chevronIcon} />
    </Button>
  );
}

/**
 * **Messages** (Overview) — the newest three accepted messages, from this
 * computer's copy of the site's messages (the Messages tab's). Absent when
 * the composition ships no intake, like the tab.
 */
export function MessagesCard({ deployment }: SiteProps): ReactNode {
  const ships = useDeploymentShips(deployment.id, INTAKE_PLUGIN_ID);
  switch (ships.kind) {
    case "no":
      return null;
    case "pending":
      return (
        <SiteCard title="Messages">
          <SiteCardBody>
            <Loading variant="rows" count={3} />
          </SiteCardBody>
        </SiteCard>
      );
    case "failed":
      return (
        <SiteCard title="Messages">
          <SiteCardBody>
            <ResourceErrorInline
              variant="block"
              subject="whether this site takes messages"
              error={ships.error}
              refetch={ships.refetch}
            />
          </SiteCardBody>
        </SiteCard>
      );
    case "yes":
      return <NewestMessages deploymentId={deployment.id} />;
  }
}

function NewestMessages({ deploymentId }: { deploymentId: string }): ReactNode {
  const copy = useMessagesCopy(deploymentId);
  return (
    <SiteCard title="Messages" trailing={<InboxLink />}>
      <SiteCardBody>
        {copy.kind === "loading" ? (
          <Loading variant="rows" count={3} />
        ) : copy.kind === "error" ? (
          <ResourceErrorInline
            variant="block"
            subject="this site's copy of its messages"
            error={copy.error}
            refetch={copy.refetch}
          />
        ) : copy.kind === "copied" ? (
          <NewestList deploymentId={deploymentId} />
        ) : (
          // Not copied yet: the freshness line says why (copying, a failed
          // pull) and asks for the first sync.
          <MirrorFreshness
            deploymentId={deploymentId}
            setId={SITE_MESSAGES_MIRROR_SET_ID}
            subject={MESSAGES_SUBJECT}
          />
        )}
      </SiteCardBody>
    </SiteCard>
  );
}

function NewestList({ deploymentId }: { deploymentId: string }): ReactNode {
  const newest = useLive(siteMessagesInbox, {
    where: { deploymentId, verdict: "accepted" },
    orderBy: [["createdAt", "desc"]],
    limit: NEWEST,
  });
  const link = useSiteTabLink("messages");
  if (newest.status === "loading") return <Loading variant="rows" count={3} />;
  if (newest.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="this site's messages"
        error={newest.error}
        refetch={newest.refetch}
      />
    );
  }
  return (
    <DataView<SiteMessageRow>
      rows={newest.data}
      collection={siteMessagesInbox}
      overrides={overrides}
      rowKey={(m) => m.id}
      views={["list"]}
      defaultView="list"
      density="compact"
      toolbar={SITE_CARD_LIST_TOOLBAR}
      storageKey={MESSAGES_CARD_VIEW}
      rowActivation={() => link}
      viewOptions={{
        list: {
          renderRow: (m: SiteMessageRow) => <MessageLine message={m} />,
        },
      }}
      emptyState={<>No one has written yet.</>}
    />
  );
}

function MessageLine({ message }: { message: SiteMessageRow }): ReactNode {
  return (
    <Fill>
      <Stack gap="2xs">
        <Line>
          <Fill>
            <Text variant="label">{message.replyTo}</Text>
          </Fill>
          <Text as="span" variant="caption" tone="faint">
            <RelativeTime date={message.createdAt} />
          </Text>
        </Line>
        <Line>
          <Text variant="caption" tone="muted">
            {firstLine(message.message)}
          </Text>
        </Line>
      </Stack>
    </Fill>
  );
}
