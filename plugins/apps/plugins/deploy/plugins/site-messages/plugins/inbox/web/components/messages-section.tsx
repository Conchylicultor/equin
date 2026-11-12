import { useMemo, useState, type ReactNode } from "react";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { RowView, useLive } from "@plugins/network/plugins/live/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import {
  useDeploymentShips,
  type HostQuerySubject,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { MirrorFreshness } from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/web";
import { SITE_MESSAGES_MIRROR_SET_ID } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import {
  SiteCard,
  SiteCardBody,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { siteMessagesInbox, type SiteMessageRow } from "../../core";
import { INTAKE_PLUGIN_ID } from "../internal/intake-plugin-id";
import { SPAM_REASON_LABEL, firstLine, replyHref } from "../internal/present";
import { useMessagesCopy } from "../internal/use-messages-copy";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MESSAGES_VIEW = defineDataView("deploy.site-messages");

/** What the freshness line's failure sentences call this set. */
export const MESSAGES_SUBJECT: HostQuerySubject = {
  reading: "messages",
  answer: "a page of messages",
};

/**
 * The live source: every message of the site's copy, searched (who wrote and
 * what they wrote) and filtered in SQL. Scoped per site below.
 */
const messagesSource = liveDataSource(siteMessagesInbox, {
  surface: MESSAGES_VIEW,
  unscoped: {
    reason:
      "served from this computer's copy of the site's table (a per-replica schema outside the change feed) — a custom column is a Postgres side table joined into a routed window, which an external window cannot join",
  },
  searchable: ["replyTo", "message"],
});

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

// What the list says of the fields it derives from `siteMessagesInbox`: the
// sender as a reply link, the message on one line (its full text opens below),
// and widths. `deploymentId` is the scope every read states — not a column.
const overrides = fieldOverrides(siteMessagesInbox, {
  replyTo: { cell: (m) => <ReplyLink replyTo={m.replyTo} />, width: "16rem" },
  message: { cell: (m) => firstLine(m.message) },
  createdAt: { width: "7rem" },
  verdict: { width: "7rem" },
  notifyState: { width: "9rem" },
  deploymentId: { visible: false, filterable: false, groupable: false },
});

/**
 * **Messages** — what visitors sent through the deployed site's contact form,
 * every one of them, from this computer's copy of the site's messages (synced
 * from the box on open, hourly and on Sync now). Shown only when the
 * deployment's composition ships the intake.
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
  const copy = useMessagesCopy(deploymentId);
  return (
    <SiteCard title="Messages">
      <SiteCardBody>
        <Stack gap="md">
          <MirrorFreshness
            deploymentId={deploymentId}
            setId={SITE_MESSAGES_MIRROR_SET_ID}
            subject={MESSAGES_SUBJECT}
          />
          {copy.kind === "loading" ? (
            <Loading variant="rows" count={4} />
          ) : copy.kind === "error" ? (
            <ResourceErrorInline
              variant="block"
              subject="this site's copy of its messages"
              error={copy.error}
              refetch={copy.refetch}
            />
          ) : copy.kind === "copied" ? (
            <MessageList deploymentId={deploymentId} />
          ) : copy.syncing ? (
            <Loading variant="rows" count={4} />
          ) : null}
        </Stack>
      </SiteCardBody>
    </SiteCard>
  );
}

function MessageList({ deploymentId }: { deploymentId: string }): ReactNode {
  // This site's messages: its scope, stated as data (never a filter the
  // user's Filter control could name or widen).
  const source = useMemo(
    () => messagesSource.scoped({ where: { deploymentId } }),
    [deploymentId],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Stack gap="md">
      <DataView<SiteMessageRow>
        source={source}
        overrides={overrides}
        views={["list", "table"]}
        defaultView="list"
        selectedRowId={openId ?? undefined}
        onRowActivate={(m) => setOpenId((id) => (id === m.id ? null : m.id))}
        recipe="inbox"
        emptyState={<>No one has written yet.</>}
      />
      {openId !== null && (
        <OpenMessage id={openId} onClose={() => setOpenId(null)} />
      )}
    </Stack>
  );
}

/** The opened message, read live by id (an email sent meanwhile updates it). */
function OpenMessage({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}): ReactNode {
  const row = useLive(siteMessagesInbox, { id });
  return (
    <RowView
      row={row}
      subject="this message"
      missing={
        <Text variant="caption" tone="muted">
          This message is no longer on the site (spam is deleted after 30 days).
        </Text>
      }
    >
      {(m) => <MessageDetail message={m} onClose={onClose} />}
    </RowView>
  );
}

/** The opened message: its full text, and everything the intake recorded. */
function MessageDetail({
  message,
  onClose,
}: {
  message: SiteMessageRow;
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
            Received {message.createdAt.toLocaleString()} on {message.host}
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
