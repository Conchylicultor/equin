import type {
  JsonlEvent,
  UserTextSegment,
} from "@plugins/conversations/plugins/transcript-watcher/core";
import {
  useRowMarkdown,
  useSectionExpand,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { EventRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import {
  UserMessageCard,
  UserMessageText,
} from "@plugins/conversations/plugins/conversation-view/plugins/user-message/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Expandable } from "@plugins/primitives/plugins/expandable/web";
import { ViewerThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";

type UserTextEvent = Extract<JsonlEvent, { kind: "user-text" }>;

function InlineImage({ mime, data }: { mime: string; data: string }) {
  // `image/svg+xml` → `svg`: the name is also the download's file name.
  const ext = mime.slice(mime.indexOf("/") + 1).split("+")[0];
  return (
    <ViewerThumbnail
      image={{
        src: `data:${mime};base64,${data}`,
        name: `pasted-image.${ext}`,
        sourceLabel: "Pasted",
        alt: "Attached image",
      }}
    />
  );
}

function SegmentedContent({
  segments,
  raw,
}: {
  segments: UserTextSegment[];
  raw: boolean;
}) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <UserMessageText key={i} text={seg.value} raw={raw} />
        ) : (
          // eslint-disable-next-line spacing/no-adhoc-spacing -- mt-1.5 spaces an inline image segment from the preceding text segment
          <div key={i} className="mt-1.5">
            <InlineImage mime={seg.mime} data={seg.data} />
          </div>
        ),
      )}
    </>
  );
}

export function UserTextRow({ event }: { event: JsonlEvent }) {
  const e = event as UserTextEvent;
  const { expanded, setExpanded } = useSectionExpand();
  const { markdownMode } = useRowMarkdown();
  const raw = !markdownMode;

  const body = e.segments ? (
    <SegmentedContent segments={e.segments} raw={raw} />
  ) : (
    <UserMessageText text={e.text} raw={raw} />
  );

  return (
    <UserMessageCard>
      <Pin to="top-right" offset="sm">
        <EventRowActions floating />
      </Pin>
      <Expandable expanded={expanded} onToggle={setExpanded}>
        {body}
      </Expandable>
    </UserMessageCard>
  );
}
