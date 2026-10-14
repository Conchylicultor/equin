import type { ReactElement } from "react";
import type { MailThreadRow } from "../../core";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { senderSummary } from "../internal/sender-summary";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const attachFileIcon = symbol("attach-file");
const labelImportantIcon = symbol("label-important");

/**
 * One Gmail-style thread row body: a two-line block — senders + important /
 * attachment markers + relative date on the first line, subject + inline snippet
 * on the second. Unread threads render their senders and subject in a bold
 * weight.
 *
 * It owns NO click and no leading star: the DataView list wraps it in the
 * selectable/clickable `Row`, and the leading star + row activation come from the
 * list's `viewOptions.list`. `data-thread-id` names the thread the row shows,
 * which the e2e scripts read to tell which threads a tab rendered.
 */
export function ThreadRow({ thread }: { thread: MailThreadRow }): ReactElement {
  const bold = thread.unread ? "font-semibold" : undefined;
  const sortDate = thread.lastMessageAt ?? thread.createdAt;

  return (
    <Fill data-thread-id={thread.id}>
      <Stack gap="2xs">
        <Line>
          <Fill>
            <Text
              variant="body"
              tone={thread.unread ? "default" : "muted"}
              className={bold}
            >
              {senderSummary(thread)}
            </Text>
          </Fill>
          {thread.important && (
            <Icon
              icon={labelImportantIcon}
              className="icon-auto text-warning"
            />
          )}
          {thread.hasAttachments && (
            <Icon
              icon={attachFileIcon}
              className="icon-auto text-muted-foreground"
            />
          )}
          <Text variant="caption" tone="muted">
            <RelativeTime date={new Date(sortDate)} />
          </Text>
        </Line>
        <Line>
          <Text variant="body" className={bold}>
            {thread.subject || "(no subject)"}
          </Text>
          {thread.snippet ? (
            <Text variant="body" tone="muted">
              {` — ${thread.snippet}`}
            </Text>
          ) : null}
        </Line>
      </Stack>
    </Fill>
  );
}
