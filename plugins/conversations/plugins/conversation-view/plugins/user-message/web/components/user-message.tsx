import type { ReactNode } from "react";
import { AttachmentText } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/**
 * One block of a user turn's text, formatted the one standard way: every
 * registered inline-text walker applied (active-data chips such as
 * `<ui-context>`, file links) and every attachment ref the composer wrote
 * (`![](/api/attachments/<id>)`) drawn as its thumbnail or file chip — so a
 * turn still on its way shows its pasted image, not the markdown — or the
 * verbatim string when `raw`.
 */
export function UserMessageText({
  text,
  raw = false,
}: {
  text: string;
  raw?: boolean;
}) {
  return (
    <Text as="div" variant="body" className="whitespace-pre-wrap break-words">
      {raw ? text : <AttachmentText text={text} />}
    </Text>
  );
}

/**
 * The user turn's card: the shape group's card corners, the thread-card pad
 * (density `padThreadCard*`) and the palette's `messageCard` fill and border —
 * each defaulting to the `rounded-md`, `md` × `sm` pad, page fill and 60%
 * hairline it always wore. Shared by the transcript's user row and the
 * optimistic pending turn, so a sent message looks the same before and after
 * the transcript confirms it.
 */
export function UserMessageCard({ children }: { children: ReactNode }) {
  return (
    <ContentScope>
      <div className="relative rounded-card border border-message-card-border bg-message-card p-thread-card">
        {children}
      </div>
    </ContentScope>
  );
}
