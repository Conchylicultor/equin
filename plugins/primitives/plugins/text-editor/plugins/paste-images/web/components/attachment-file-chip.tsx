import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import { openInBrowserTab } from "@plugins/primitives/plugins/link-gesture/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { attachmentUrl } from "../internal/markdown";
import {
  AttachmentSlots,
  type AttachedFileRef,
  type AttachmentOpener,
} from "../slots";

/**
 * A non-image attachment in a prompt: the same {@link LinkChip} every other
 * inline chip is (tasks, attempts, commits), led by its file-type glyph. It
 * opens through the contributed {@link AttachmentSlots.Opener} (a preview pane
 * beside the surface), else the raw file in a new browser tab. The image twin is
 * {@link AttachmentThumbnail}. In an editor its node wraps it in `TokenFrame`
 * (selection ring, Remove).
 */
export function AttachmentFileChip({
  attachmentId,
  filename,
}: {
  attachmentId: string;
  filename: string;
}) {
  const name = filename || "Attached file";
  const opener = AttachmentSlots.Opener.useContributions()[0];
  const file = { attachmentId, filename: name };
  // The opener is a contributed HOOK, and contributions arrive as the plugin
  // tiers load — a chip restored from a draft renders before the opener's
  // plugin has. Each source of the link is its own component type, so the
  // opener's arrival remounts the link instead of changing this one's hooks.
  return opener ? (
    <OpenerLink useTarget={opener.useTarget} file={file} />
  ) : (
    <RawFileLink file={file} />
  );
}

function OpenerLink({
  useTarget,
  file,
}: {
  useTarget: AttachmentOpener["useTarget"];
  file: AttachedFileRef;
}) {
  return <FileLink file={file} target={useTarget()(file)} />;
}

/** No preview to open: the raw file, in a tab — "here" and "elsewhere" alike. */
function RawFileLink({ file }: { file: AttachedFileRef }) {
  const url = attachmentUrl(file.attachmentId);
  return (
    <FileLink
      file={file}
      target={{ open: () => openInBrowserTab(url), href: () => url }}
    />
  );
}

function FileLink({
  file,
  target,
}: {
  file: AttachedFileRef;
  target: LinkTarget;
}) {
  return (
    <LinkChip
      activation={target}
      title={file.filename}
      leading={<FileTypeIcon name={file.filename} />}
    >
      {file.filename}
    </LinkChip>
  );
}
