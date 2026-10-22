import { registerBlockPasteHandler } from "@plugins/page/plugins/editor/web";
import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import { fileBlock } from "../../core";

// Side-effect: pasting any file anywhere in a page creates a file
// block. The catch-all `"*"` accept makes this the lowest-priority handler, so
// image/video/audio handlers win for their MIME types.
registerBlockPasteHandler({
  id: "file",
  type: fileBlock.type,
  accept: "*",
  build: async (file, { fetchEndpoint }) => {
    const res = await uploadAttachment(
      fetchEndpoint,
      file,
      file.name,
      file.type,
    );
    return {
      attachmentId: res.id,
      filename: res.filename,
      mime: res.mime,
      size: res.size,
    };
  },
});
