import { registerBlockPasteHandler } from "@plugins/page/plugins/editor/web";
import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import { videoBlock } from "../../core";

// Side-effect: pasting a video file anywhere in a page creates a
// video block.
registerBlockPasteHandler({
  id: "video",
  type: videoBlock.type,
  accept: "video/*",
  build: async (file, { fetchEndpoint }) => {
    const res = await uploadAttachment(
      fetchEndpoint,
      file,
      file.name,
      file.type,
    );
    return { attachmentId: res.id, filename: res.filename, mime: res.mime };
  },
});
