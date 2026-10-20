import { transcriptImageUrl } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { EventRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { ViewerThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

type UserImageEvent = Extract<JsonlEvent, { kind: "user-image" }>;

export function UserImageRow({ event }: { event: JsonlEvent }) {
  const e = event as UserImageEvent;
  const { mime, key } = e.image;
  // The bytes load from their own (forever-cached) URL, never ride the event.
  const src = transcriptImageUrl(key);
  // `image/svg+xml` → `svg`: the name is also the download's file name.
  const ext = mime.slice(mime.indexOf("/") + 1).split("+")[0];
  return (
    <div className="flow-root rounded-md border border-border/60 bg-background px-md py-sm">
      <EventRowActions float />
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mb-1 spaces the label from the image below it */}
      <SectionLabel className="mb-1 text-3xs">
        <Stack direction="row" gap="sm" align="center">
          <span>User image</span>
          <span>{mime}</span>
        </Stack>
      </SectionLabel>
      <ViewerThumbnail
        image={{
          src,
          name: `pasted-image.${ext}`,
          sourceLabel: "Pasted",
          alt: "User-pasted image",
        }}
      />
    </div>
  );
}
