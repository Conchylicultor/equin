import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  HostQueryFailureState,
  useDeploymentShips,
  type HostQuerySubject,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import {
  NOTIFY_STATES,
  SITE_MESSAGE_VERDICTS,
  type SiteMessageRecord,
  type SiteMessagesPage,
} from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { deploymentSiteMessages } from "../../core";
import { INTAKE_PLUGIN_ID } from "../internal/intake-plugin-id";
import {
  NOTIFY_LABEL,
  NOTIFY_VARIANT,
  SPAM_REASON_LABEL,
  VERDICT_LABEL,
  VERDICT_VARIANT,
  replyHref,
} from "../internal/present";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MESSAGES_VIEW = defineDataView("deploy.site-messages");

const refreshIcon = symbol("refresh");

const MESSAGES_SUBJECT: HostQuerySubject = {
  reading: "messages",
  answer: "a list of messages",
};

function ReplyLink({ replyTo }: { replyTo: string }): ReactNode {
  return (
    <a
      href={replyHref(replyTo)}
      className="underline decoration-border underline-offset-2 hover:decoration-current"
      // A reply link inside an activatable row: replying must not also open it.
      onClick={(e) => e.stopPropagation()}
    >
      {replyTo}
    </a>
  );
}

const FIELDS: FieldDef<SiteMessageRecord>[] = [
  {
    id: "message",
    label: "Message",
    type: "text",
    primary: true,
    value: (m) => m.message,
  },
  {
    id: "replyTo",
    label: "From",
    type: "text",
    value: (m) => m.replyTo,
    cell: (m) => <ReplyLink replyTo={m.replyTo} />,
    sortable: true,
    width: "16rem",
  },
  {
    id: "createdAt",
    label: "Received",
    type: "date",
    value: (m) => new Date(m.createdAt),
    cell: (m) => (
      <Text variant="caption" tone="muted">
        <RelativeTime date={new Date(m.createdAt)} />
      </Text>
    ),
    sortable: true,
    filterable: true,
    width: "7rem",
  },
  {
    id: "verdict",
    label: "Verdict",
    type: "enum",
    value: (m) => m.verdict,
    options: SITE_MESSAGE_VERDICTS.map((value) => ({
      value,
      label: VERDICT_LABEL[value],
    })),
    cell: (m) => (
      <Badge variant={VERDICT_VARIANT[m.verdict]}>
        {VERDICT_LABEL[m.verdict]}
      </Badge>
    ),
    filterable: true,
    groupable: true,
    width: "7rem",
  },
  {
    id: "notifyState",
    label: "Notification",
    type: "enum",
    value: (m) => m.notifyState,
    options: NOTIFY_STATES.map((value) => ({
      value,
      label: NOTIFY_LABEL[value],
    })),
    cell: (m) => (
      <Badge variant={NOTIFY_VARIANT[m.notifyState]}>
        {NOTIFY_LABEL[m.notifyState]}
      </Badge>
    ),
    filterable: true,
    groupable: true,
    width: "9rem",
  },
];

/**
 * **Messages** — what visitors sent through the deployed site's contact form,
 * read from the box over SSH when the section opens (and on Refresh). Shown
 * only when the deployment's composition ships the intake.
 */
export function MessagesSection({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const ships = useDeploymentShips(deploymentId, INTAKE_PLUGIN_ID);
  switch (ships.kind) {
    case "pending":
      return <Loading variant="rows" count={3} />;
    case "failed":
      return (
        <ResourceErrorInline
          variant="block"
          subject="whether this deployment takes messages"
          error={ships.error}
          refetch={ships.refetch}
        />
      );
    case "yes":
      return <MessagesInbox deploymentId={deploymentId} />;
    // The gate removes the card on `no`; a frame between the two renders
    // nothing rather than a spinner for a card that is going away.
    case "no":
      return null;
  }
}

function MessagesInbox({ deploymentId }: { deploymentId: string }): ReactNode {
  // One snapshot per deployment; each measure is an SSH session to the box,
  // so nothing re-asks on its own — Refresh (`refresh()`) is the re-ask.
  const answer = useLive(deploymentSiteMessages, { deploymentId });
  return (
    <Stack gap="md">
      <Line>
        <Fill>
          <Text variant="caption" tone="muted">
            Read from the server when this page opens.
          </Text>
        </Fill>
        <IconButton
          icon={refreshIcon}
          label="Refresh"
          loading={answer.status === "loading"}
          onClick={() => answer.refresh()}
        />
      </Line>
      {answer.status === "loading" ? (
        <Loading variant="rows" count={4} />
      ) : answer.status === "error" ? (
        <ResourceErrorInline
          variant="block"
          subject="this deployment's messages"
          error={answer.error}
          refetch={answer.refresh}
        />
      ) : answer.data.kind === "messages" ? (
        <MessageList page={answer.data} />
      ) : (
        <HostQueryFailureState
          failure={answer.data}
          subject={MESSAGES_SUBJECT}
        />
      )}
    </Stack>
  );
}

function MessageList({ page }: { page: SiteMessagesPage }): ReactNode {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = useMemo(
    () => page.messages.find((m) => m.id === openId) ?? null,
    [page.messages, openId],
  );
  return (
    <Stack gap="md">
      <DataView<SiteMessageRecord>
        rows={page.messages}
        fields={FIELDS}
        rowKey={(m) => m.id}
        views={["list", "table"]}
        defaultView="list"
        storageKey={MESSAGES_VIEW}
        selectedRowId={openId ?? undefined}
        onRowActivate={(m) => setOpenId((id) => (id === m.id ? null : m.id))}
        searchAccessor={(m) => `${m.replyTo} ${m.message}`}
        viewOptions={{
          list: {
            renderRow: (m: SiteMessageRecord) => <MessageRow message={m} />,
          },
        }}
        emptyState={<>No one has written yet.</>}
      />
      {page.hasMore && (
        <Text variant="caption" tone="muted">
          Showing the newest {page.messages.length} messages.
        </Text>
      )}
      {open && <MessageDetail message={open} onClose={() => setOpenId(null)} />}
    </Stack>
  );
}

/** One message in the list: who and when over the first line of what they wrote. */
function MessageRow({ message }: { message: SiteMessageRecord }): ReactNode {
  return (
    <Fill>
      <Stack gap="2xs">
        <Cluster gap="xs">
          <Text variant="label">
            <ReplyLink replyTo={message.replyTo} />
          </Text>
          <Badge variant={VERDICT_VARIANT[message.verdict]}>
            {VERDICT_LABEL[message.verdict]}
          </Badge>
          <Badge variant={NOTIFY_VARIANT[message.notifyState]}>
            {NOTIFY_LABEL[message.notifyState]}
          </Badge>
          <Text as="span" variant="caption" tone="muted">
            <RelativeTime date={new Date(message.createdAt)} />
          </Text>
        </Cluster>
        <Line>
          <Text variant="caption" tone="muted">
            {message.message}
          </Text>
        </Line>
      </Stack>
    </Fill>
  );
}

/** The opened message: its full text, and everything the intake recorded. */
function MessageDetail({
  message,
  onClose,
}: {
  message: SiteMessageRecord;
  onClose: () => void;
}): ReactNode {
  return (
    <Card>
      <Stack gap="md">
        <Line>
          <Fill>
            <Text variant="label">
              <ReplyLink replyTo={message.replyTo} />
            </Text>
          </Fill>
          <Button
            variant="outline"
            render={<a href={replyHref(message.replyTo)} />}
          >
            Reply
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </Line>
        <Text as="p" variant="body" className="whitespace-pre-wrap break-words">
          {message.message}
        </Text>
        <Stack gap="2xs">
          <Text variant="caption" tone="muted">
            Received {new Date(message.createdAt).toLocaleString()} on{" "}
            {message.host}
            {message.page}
          </Text>
          {message.spamReason && (
            <Text variant="caption" tone="muted">
              Filed as spam: {SPAM_REASON_LABEL[message.spamReason]}.
            </Text>
          )}
          {message.notifyError && (
            <Text variant="caption" tone="destructive">
              Email: {message.notifyError}
            </Text>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
