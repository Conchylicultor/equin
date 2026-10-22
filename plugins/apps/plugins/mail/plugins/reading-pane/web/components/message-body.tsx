import { useState } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { MailHtml } from "@plugins/apps/plugins/mail/plugins/mail-html/web";
import { AttachmentChip } from "@plugins/apps/plugins/mail/plugins/attachments/web";
import type { MailAttachment } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { MessageBodyState } from "@plugins/apps/plugins/mail/plugins/sync/web";
import { useResolveCid } from "../internal/use-resolve-cid";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const imageIcon = symbol("image");

// Renders a message body. Mounted only when its card is expanded (the collapsible
// unmounts its content when closed), so its `mail.message-body` subscription —
// which asks for the body's first fetch — starts on first open. Its loading and
// failed-fetch states are sync's `MessageBodyState`, shared with every pane that
// shows a body.
export function MessageBody({ messageId }: { messageId: string }) {
  return (
    <MessageBodyState
      messageId={messageId}
      ready={(b) => (
        <RenderedBody
          html={b.bodyHtml}
          text={b.bodyText}
          attachments={b.attachments}
        />
      )}
    />
  );
}

function RenderedBody({
  html,
  text,
  attachments,
}: {
  html: string | null;
  text: string | null;
  attachments: MailAttachment[];
}) {
  const [showRemoteImages, setShowRemoteImages] = useState(false);
  const [remoteDetected, setRemoteDetected] = useState(false);
  const resolveCid = useResolveCid(attachments);

  // Non-inline attachments get chips below the body; inline ones are the cid:
  // images resolved into the HTML.
  const fileAttachments = attachments.filter((a) => !a.inline);

  return (
    <Stack gap="sm">
      {remoteDetected && !showRemoteImages ? (
        <Row
          bordered
          icon={<Icon icon={imageIcon} className="icon-auto" />}
          actionsAlwaysVisible
          actions={
            <Button
              variant="outline"
              onClick={() => {
                setShowRemoteImages(true);
              }}
            >
              Display images
            </Button>
          }
        >
          <Text variant="caption" tone="muted">
            Images are hidden to protect your privacy.
          </Text>
        </Row>
      ) : null}

      {html ? (
        <MailHtml
          html={html}
          showRemoteImages={showRemoteImages}
          onRemoteImagesDetected={setRemoteDetected}
          resolveCid={resolveCid}
        />
      ) : text ? (
        <Text
          as="pre"
          variant="body"
          className="whitespace-pre-wrap break-words font-sans"
        >
          {text}
        </Text>
      ) : (
        <Placeholder tone="muted">This message has no content.</Placeholder>
      )}

      {fileAttachments.length > 0 ? (
        <Cluster>
          {fileAttachments.map((att) => (
            <AttachmentChip key={att.id} attachment={att} />
          ))}
        </Cluster>
      ) : null}
    </Stack>
  );
}
