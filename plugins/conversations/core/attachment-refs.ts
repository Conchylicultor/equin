import {
  attachmentFileMarkdown,
  attachmentMarkdown,
} from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";

/**
 * How an attachment a prompt references reaches the agent: Claude's own
 * disk-path syntax, `@<absolute path>`. The trailing space is load-bearing:
 * two adjacent image nodes serialize as `![](url1)![](url2)` with no
 * separator, and without it they would fuse into `@path1@path2`, which
 * Claude's `@`-reference expansion (and our transcript parser) read as one
 * bogus path. The server writes it (`resolveAttachmentRefs`); `attachmentRefsOf`
 * reads it back.
 */
export function attachmentDiskRef(diskPath: string): string {
  return `@${diskPath} `;
}

// An attachment's bytes live at `<attachments dir>/<id><ext>` (infra/attachments'
// `diskPathFor`), the id a UUID and the dir named `attachments` (its data dir,
// and the legacy `apps/attachments` it moved from).
const DISK_PATH = String.raw`\S*\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[A-Za-z0-9]+)?`;
const DISK_REF_RE = new RegExp(`@(${DISK_PATH}) ?`, "g");
const DISK_PATH_RE = new RegExp(`^${DISK_PATH}$`);

/**
 * Whether `path` is an attachment's stored file — one a prompt reaches the
 * agent through as `@<path>` and `attachmentRefsOf` draws back as the
 * attachment itself, so a surface showing the prompt already shows the file.
 */
export function isAttachmentDiskPath(path: string): boolean {
  return DISK_PATH_RE.test(path);
}

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
  ".heic",
]);

/**
 * The inverse of the server's resolve: every `@<attachment disk path>` the
 * agent was handed, back as the attachment markdown the prompt was written
 * with — an image as `![](/api/attachments/<id>)`, any other file as a file
 * ref named by its stored file name (the original name never reached the
 * agent). Lets a surface draw what the agent read (its own record) the way the
 * user wrote it: thumbnails and file chips, not paths.
 */
export function attachmentRefsOf(text: string): string {
  return text.replace(
    DISK_REF_RE,
    (_whole, _path: string, id: string, ext: string | undefined) => {
      const lower = ext?.toLowerCase() ?? "";
      return IMAGE_EXTS.has(lower)
        ? attachmentMarkdown(id)
        : attachmentFileMarkdown(id, `${id}${lower}`);
    },
  );
}
