import { useState, type ReactNode } from "react";

import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import type { MailAttachment } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { mailAttachmentUrl } from "../../core";
import { useMailAttachment } from "../internal/use-mail-attachment";
import { formatBytes } from "../internal/format-bytes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const draftIcon = symbol("draft");
const imageIcon = symbol("image");
const pictureAsPdfIcon = symbol("picture-as-pdf");
const videoFileIcon = symbol("video-file");
const audioFileIcon = symbol("audio-file");
const archiveIcon = symbol("archive");
const descriptionIcon = symbol("description");

/**
 * Render a Material MIME-type icon element. Returns an element (not a component
 * type) so callers never create a component during render (which would reset
 * state and trips the `react-hooks/static-components` rule).
 */
function mimeIcon(mime: string): ReactNode {
  const cls = "icon-auto";
  if (mime.startsWith("image/"))
    return <Icon icon={imageIcon} className={cls} />;
  if (mime.startsWith("video/"))
    return <Icon icon={videoFileIcon} className={cls} />;
  if (mime.startsWith("audio/"))
    return <Icon icon={audioFileIcon} className={cls} />;
  if (mime === "application/pdf")
    return <Icon icon={pictureAsPdfIcon} className={cls} />;
  if (
    mime.includes("zip") ||
    mime.includes("compressed") ||
    mime.includes("tar") ||
    mime.includes("gzip")
  ) {
    return <Icon icon={archiveIcon} className={cls} />;
  }
  if (mime.startsWith("text/") || mime.includes("document"))
    return <Icon icon={descriptionIcon} className={cls} />;
  return <Icon icon={draftIcon} className={cls} />;
}

export interface AttachmentChipProps {
  attachment: MailAttachment;
}

/**
 * A downloadable attachment chip: MIME icon + filename + human size. Clicking
 * downloads the bytes on demand (a spinner shows while in flight), then opens the
 * resulting same-origin URL in a new tab. A already-stored attachment resolves
 * instantly with no server round-trip.
 */
export function AttachmentChip({ attachment }: AttachmentChipProps) {
  const { download } = useMailAttachment();
  const [pending, setPending] = useState(false);

  async function open() {
    if (pending) return;
    setPending(true);
    try {
      const url = attachment.storedAttachmentId
        ? mailAttachmentUrl(attachment.storedAttachmentId)
        : await download(attachment.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setPending(false);
    }
  }

  return (
    <Badge
      as="button"
      type="button"
      shape="pill"
      variant="muted"
      tooltip={attachment.filename}
      onClick={() => {
        void open();
      }}
      icon={
        pending ? (
          <Spinner className="icon-auto" />
        ) : (
          mimeIcon(attachment.mimeType)
        )
      }
    >
      {attachment.filename} · {formatBytes(attachment.sizeBytes)}
    </Badge>
  );
}
