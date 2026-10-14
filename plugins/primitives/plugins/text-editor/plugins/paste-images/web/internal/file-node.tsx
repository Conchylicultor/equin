import type { LexicalNode } from "lexical";
import { TokenFrame } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/web";
import { fileNode } from "./markdown";
import { AttachmentFileChip } from "../components/attachment-file-chip";

/**
 * The browser half of the attached-file token: the SAME family declared in
 * `core/node.ts`, with rendering added.
 */
export const fileWebNode = fileNode.decorated({
  className: "inline-flex align-middle mx-0.5",
  render: ({ attachmentId, filename }, node) => (
    <TokenFrame nodeKey={node.getKey()} removeLabel="Remove file">
      <AttachmentFileChip attachmentId={attachmentId} filename={filename} />
    </TokenFrame>
  ),
});

export function $createFileNode(payload: {
  attachmentId: string;
  filename: string;
}): LexicalNode {
  return fileWebNode.create(payload);
}
