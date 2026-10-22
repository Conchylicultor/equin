import {
  assetPath,
  interpolatePath,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import { getAttachmentFile } from "@plugins/infra/plugins/attachments/core";

const ATTACHMENT_URL_RE = /^\/api\/attachments\/([A-Za-z0-9_-]+)$/;

/**
 * Any attachment reference in a prompt: an image (`![alt](url)`, drawn as a
 * thumbnail) or any other file (`[name](url)`, drawn as a file chip). Both
 * spellings resolve the same way server-side (to `@<disk path>`), so every
 * consumer that only needs the ids, or strips the refs, reads this one.
 * Group 1 is the alt / file name, group 2 the url.
 */
export const ATTACHMENT_MARKDOWN_RE = /!?\[([^\]]*)\]\(([^)\s]+)\)/g;
/** An image attachment reference only: `![alt](url)`. */
export const ATTACHMENT_IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
/** A non-image file attachment reference only: `[name](url)`, no leading `!`. */
export const ATTACHMENT_FILE_MARKDOWN_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * An attachment's bytes as an asset an element loads — through `useAssetSrc`
 * (`endpoints/web`), over the subtree's transport, never as a bare URL.
 */
export function attachmentUrl(id: string): AssetPath {
  return assetPath(getAttachmentFile, { id });
}

/**
 * The address an attachment is PERSISTED under in markdown — the route it is
 * served at (`/api/attachments/<id>`), written into a document, never handed to
 * an element (the reader converts it back: `isAttachmentUrl` → `attachmentUrl`).
 */
function persistedAttachmentAddress(id: string): string {
  return interpolatePath(getAttachmentFile.path, { id });
}

export function attachmentMarkdown(id: string, alt = ""): string {
  return `![${label(alt)}](${persistedAttachmentAddress(id)})`;
}

/** A non-image file reference: `[name](/api/attachments/<id>)`. */
export function attachmentFileMarkdown(id: string, filename: string): string {
  return `[${label(filename)}](${persistedAttachmentAddress(id)})`;
}

/**
 * The reference an uploaded attachment is written as: an image becomes a
 * thumbnail, anything else a file chip.
 */
export function attachmentRefMarkdown(att: {
  id: string;
  filename: string;
  mime: string;
}): string {
  return isImageMime(att.mime)
    ? attachmentMarkdown(att.id, att.filename)
    : attachmentFileMarkdown(att.id, att.filename);
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Whether a {@link ATTACHMENT_MARKDOWN_RE} match is the image spelling. */
export function isImageRef(match: string): boolean {
  return match.startsWith("!");
}

export function isAttachmentUrl(url: string): string | null {
  const m = ATTACHMENT_URL_RE.exec(url);
  return m?.[1] ?? null;
}

export function extractAttachmentIds(markdown: string): string[] {
  const ids = new Set<string>();
  for (const m of markdown.matchAll(ATTACHMENT_MARKDOWN_RE)) {
    const id = isAttachmentUrl(m[2]!);
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export function rewriteAttachmentMarkdown(
  markdown: string,
  rewrite: (id: string, alt: string) => string,
): string {
  return markdown.replace(
    ATTACHMENT_MARKDOWN_RE,
    (whole: string, alt: string, url: string) => {
      const id = isAttachmentUrl(url);
      return id ? rewrite(id, alt) : whole;
    },
  );
}

/** A name that cannot close the bracket it sits in, nor span lines. */
function label(text: string): string {
  return text.replace(/[[\]\n\r]/g, " ");
}
