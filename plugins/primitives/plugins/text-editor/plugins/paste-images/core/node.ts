import { defineInlineTokenNode } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/core";
import {
  attachmentFileMarkdown,
  attachmentMarkdown,
  isAttachmentUrl,
} from "./internal/markdown";

/**
 * The pasted-attachment-image token family's ONE declaration. Its token is
 * ordinary image markdown pointing at an attachment — `![alt](/api/attachments/<id>)`.
 *
 * A `type` alias, never an `interface`: TypeScript grants an implicit index
 * signature to the former only, and without it this does not satisfy the
 * `F extends TokenFields` constraint — `defineInlineTokenNode` rejects it.
 */
export type ImageFields = { attachmentId: string; alt: string };

/**
 * `textContent: "token"`, as `inline-chip`'s family and for the same reason: a
 * prompt editor is a plain-text Lexical editor, whose copy writes ONLY
 * `text/plain`, built from each node's text content — an empty one dropped the
 * attachment on copy, and a paste over the selection then deleted it. Emitting
 * the token lets `TokenPastePlugin` rebuild the node wherever it is pasted.
 */
export const imageNode = defineInlineTokenNode<ImageFields>({
  type: "paste-image",
  fields: ["attachmentId", "alt"],
  token: ({ attachmentId, alt }) => attachmentMarkdown(attachmentId, alt),
  // Image markdown pointing ANYWHERE ELSE is not this token: returning null
  // leaves those bytes as plain text rather than swallowing the span.
  fieldsOf: (match) => {
    const attachmentId = isAttachmentUrl(match[2]!);
    return attachmentId === null ? null : { attachmentId, alt: match[1] ?? "" };
  },
  textContent: "token",
});

/** A non-image attached file: its name, and where its bytes are. */
export type FileFields = { attachmentId: string; filename: string };

/**
 * The attached-file token family: a link pointing at an attachment —
 * `[name](/api/attachments/<id>)` — drawn as a file chip. Its pattern carries
 * no leading `!`, so it never claims an image reference.
 */
export const fileNode = defineInlineTokenNode<FileFields>({
  type: "attached-file",
  fields: ["attachmentId", "filename"],
  token: ({ attachmentId, filename }) =>
    attachmentFileMarkdown(attachmentId, filename),
  fieldsOf: (match) => {
    const attachmentId = isAttachmentUrl(match[2]!);
    return attachmentId === null
      ? null
      : { attachmentId, filename: match[1] ?? "" };
  },
  textContent: "token",
});
