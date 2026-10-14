import { registerNodeExtension } from "@plugins/primitives/plugins/text-editor/web";
import { imageWebNode } from "./image-node";
import { fileWebNode } from "./file-node";
import {
  ATTACHMENT_FILE_MARKDOWN_RE,
  ATTACHMENT_IMAGE_MARKDOWN_RE,
} from "./markdown";

// Side-effect: teach the text editor about attachments — an image as a
// thumbnail, any other file as a chip. The token formats and the fields they
// carry are declared once in `core/node.ts`, so the markdown this writes and the
// markdown it reads back cannot disagree.
registerNodeExtension({
  id: "paste-image",
  node: imageWebNode,
  pattern: ATTACHMENT_IMAGE_MARKDOWN_RE,
});
registerNodeExtension({
  id: "attached-file",
  node: fileWebNode,
  pattern: ATTACHMENT_FILE_MARKDOWN_RE,
});
