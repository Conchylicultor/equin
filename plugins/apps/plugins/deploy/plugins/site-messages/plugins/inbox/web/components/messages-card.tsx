import { useMemo, type ReactNode } from "react";
import {
  HostQueryFailureState,
  useDeploymentShips,
  type HostQuerySubject,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import {
  SITE_CARD_LIST_TOOLBAR,
  SiteCard,
  SiteCardBody,
  useSiteTabLink,
  type SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import type { SiteMessageRecord } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { deploymentSiteMessages } from "../../core";
import { INTAKE_PLUGIN_ID } from "../internal/intake-plugin-id";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MESSAGES_CARD_VIEW = defineDataView("deploy.site-messages.overview");

const chevronIcon = symbol("chevron-right");

/** How many messages the Overview shows. */
const NEWEST = 3;

const SUBJECT: HostQuerySubject = {
  reading: "messages",
  answer: "a list of messages",
};

const firstLine = (m: SiteMessageRecord): string => m.message.split("\n")[0]!;

const FIELDS: FieldDef<SiteMessageRecord>[] = [
  {
    id: "replyTo",
    label: "From",
    type: "text",
    primary: true,
    value: (m) => m.replyTo,
  },
  { id: "message", label: "Message", type: "text", value: firstLine },
  {
    id: "createdAt",
    label: "Received",
    type: "date",
    value: (m) => new Date(m.createdAt),
  },
];

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
 * **Messages** (Overview) — the newest three accepted messages, from the same
 * snapshot the Messages tab and its badge read. Absent when the composition
 * ships no intake, like the tab.
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
  const answer = useLive(deploymentSiteMessages, { deploymentId });
  const link = useSiteTabLink("messages");
  const newest = useMemo(
    () =>
      answer.status === "ready" && answer.data.kind === "messages"
        ? answer.data.messages
            .filter((m) => m.verdict === "accepted")
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, NEWEST)
        : [],
    [answer],
  );
  return (
    <SiteCard title="Messages" trailing={<InboxLink />}>
      <SiteCardBody>
        {answer.status === "loading" ? (
          <Loading variant="rows" count={3} />
        ) : answer.status === "error" ? (
          <ResourceErrorInline
            variant="block"
            subject="this site's messages"
            error={answer.error}
            refetch={answer.refresh}
          />
        ) : answer.data.kind !== "messages" ? (
          <HostQueryFailureState failure={answer.data} subject={SUBJECT} />
        ) : (
          <DataView<SiteMessageRecord>
            rows={newest}
            fields={FIELDS}
            rowKey={(m) => m.id}
            views={["list"]}
            defaultView="list"
            density="compact"
            toolbar={SITE_CARD_LIST_TOOLBAR}
            storageKey={MESSAGES_CARD_VIEW}
            rowActivation={() => link}
            viewOptions={{
              list: {
                renderRow: (m: SiteMessageRecord) => (
                  <MessageLine message={m} />
                ),
              },
            }}
            emptyState={<>No one has written yet.</>}
          />
        )}
      </SiteCardBody>
    </SiteCard>
  );
}

function MessageLine({ message }: { message: SiteMessageRecord }): ReactNode {
  return (
    <Fill>
      <Stack gap="2xs">
        <Line>
          <Fill>
            <Text variant="label">{message.replyTo}</Text>
          </Fill>
          <Text as="span" variant="caption" tone="faint">
            <RelativeTime date={new Date(message.createdAt)} />
          </Text>
        </Line>
        <Line>
          <Text variant="caption" tone="muted">
            {firstLine(message)}
          </Text>
        </Line>
      </Stack>
    </Fill>
  );
}
