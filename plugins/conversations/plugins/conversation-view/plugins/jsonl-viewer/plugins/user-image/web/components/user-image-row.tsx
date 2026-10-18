import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { EventRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { ViewerThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

type UserImageEvent = Extract<JsonlEvent, { kind: "user-image" }>;

export function UserImageRow({ event }: { event: JsonlEvent }) {
  const e = event as UserImageEvent;
  const src = `data:${e.mime};base64,${e.data}`;
  // `image/svg+xml` → `svg`: the name is also the download's file name.
  const ext = e.mime.slice(e.mime.indexOf("/") + 1).split("+")[0];
  return (
    <div className="flow-root rounded-md border border-border/60 bg-background px-md py-sm">
      <EventRowActions float />
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mb-1 spaces the label from the image below it */}
      <SectionLabel className="mb-1 text-3xs">
        <Stack direction="row" gap="sm" align="center">
          <span>User image</span>
          <span>{e.mime}</span>
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
