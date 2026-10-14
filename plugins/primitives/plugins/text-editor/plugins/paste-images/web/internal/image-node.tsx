import type { LexicalNode } from "lexical";
import { TokenFrame } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/web";
import { imageNode } from "./markdown";
import { AttachmentThumbnail } from "../components/attachment-thumbnail";

export type ImageNodePayload = {
  attachmentId: string;
  alt?: string;
};

/**
 * The browser half of the pasted-image token: the SAME family declared in
 * `core/node.ts`, with rendering added.
 */
export const imageWebNode = imageNode.decorated({
  className: "inline-flex align-middle mx-0.5",
  render: ({ attachmentId, alt }, node) => (
    <TokenFrame nodeKey={node.getKey()} removeLabel="Remove image">
      <AttachmentThumbnail attachmentId={attachmentId} alt={alt} />
    </TokenFrame>
  ),
});

/** The Lexical class to register in the text editor's `nodes` config. */
export const ImageNode = imageWebNode.Node;

export function $createImageNode(payload: ImageNodePayload): LexicalNode {
  return imageWebNode.create({
    attachmentId: payload.attachmentId,
    alt: payload.alt ?? "",
  });
}
