import { registerBlockPasteHandler } from "@plugins/page/plugins/editor/web";
import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import { imageBlock } from "../../core";

// Side-effect: pasting an image file anywhere in a page creates an
// image block. Width is left unset — the renderer defaults it to 480.
registerBlockPasteHandler({
  id: "image",
  type: imageBlock.type,
  accept: "image/*",
  build: async (file, { fetchEndpoint }) => {
    const res = await uploadAttachment(
      fetchEndpoint,
      file,
      file.name,
      file.type,
    );
    return { attachmentId: res.id };
  },
});
