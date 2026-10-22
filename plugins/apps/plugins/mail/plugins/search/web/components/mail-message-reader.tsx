import {
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { MessageBodyState } from "@plugins/apps/plugins/mail/plugins/sync/web";
import { threadMessages } from "@plugins/apps/plugins/mail/plugins/reading-pane/core";
import type { MailAddress } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { mailMessagePane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const attachFileIcon = symbol("attach-file");

function formatAddress(a: MailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

/**
 * The subject of the message the body read, handed to the header's title: the
 * body wraps `PaneChrome`, so the title cell mounts under it. `null` while it
 * is not known.
 */
const MessageSubjectContext = createContext<string | null>(null);

/** The pane's header title: the message's subject, or "Message" while unknown. */
export function MailMessageTitle(): string {
  return useContext(MessageSubjectContext) ?? "Message";
}

/**
 * The reader pane for one message. Its envelope (subject / from / to / date) is
 * the message's live row in the mirror (`threadMessages`' point read); its body
 * and attachments are the `mail.message-body` value, whose subscription asks
 * for a body not cached yet to be fetched — not fetched yet is the loading
 * state, a failed fetch says why with a Retry.
 *
 * `bodyHtml` is deliberately NEVER rendered here (no sanitizer on this pane) —
 * only the plain-text alternative is shown. (Follow-up: sanitized HTML
 * rendering, attachment download.)
 */
export function MailMessageBody(): ReactElement {
  const { messageId } = mailMessagePane.useParams();
  const envelope = useLiveRow(threadMessages, messageId);
  const subject =
    envelope.status === "ready" && envelope.found
      ? (envelope.row.subject ?? "")
      : null;

  let content: ReactNode;
  switch (envelope.status) {
    case "loading":
      content = <Loading variant="text" label="Loading message…" />;
      break;
    case "error":
      content = (
        <ResourceErrorInline
          error={envelope.error}
          refetch={envelope.refetch}
          variant="block"
        />
      );
      break;
    case "ready":
      content = envelope.found ? (
        <Stack gap="lg">
          <Stack gap="2xs">
            <Text variant="heading">
              {envelope.row.subject || "(no subject)"}
            </Text>
            <Text variant="label">{formatAddress(envelope.row.from)}</Text>
            {envelope.row.to.length > 0 && (
              <Text variant="caption" tone="muted">
                to {envelope.row.to.map((a) => a.name ?? a.email).join(", ")}
              </Text>
            )}
            {envelope.row.internalDate && (
              <Text variant="caption" tone="muted">
                <RelativeTime date={envelope.row.internalDate} />
              </Text>
            )}
          </Stack>
          <MessageText messageId={messageId} />
        </Stack>
      ) : (
        <Placeholder tone="muted">
          This message is not in the local mailbox.
        </Placeholder>
      );
      break;
  }

  return (
    <MessageSubjectContext.Provider value={subject}>
      <PaneChrome pane={mailMessagePane}>
        <Inset pad="lg">{content}</Inset>
      </PaneChrome>
    </MessageSubjectContext.Provider>
  );
}

/** The message's attachments and plain-text body, as the body value has them. */
function MessageText({ messageId }: { messageId: string }): ReactNode {
  return (
    <MessageBodyState
      messageId={messageId}
      loadingLabel="Loading message…"
      ready={(b) => (
        <Stack gap="lg">
          {b.attachments.length > 0 && (
            <Cluster>
              {b.attachments.map((att) => (
                <Badge key={att.id} icon={<Icon icon={attachFileIcon} />}>
                  {att.filename}
                </Badge>
              ))}
            </Cluster>
          )}
          {b.bodyText ? (
            <Text
              as="pre"
              variant="body"
              className="whitespace-pre-wrap break-words"
            >
              {b.bodyText}
            </Text>
          ) : b.bodyHtml ? (
            <Placeholder tone="muted">
              Plain-text version unavailable.
            </Placeholder>
          ) : (
            <Placeholder tone="muted">No message body.</Placeholder>
          )}
        </Stack>
      )}
    />
  );
}
