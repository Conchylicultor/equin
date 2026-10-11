import type { ReactNode } from "react";
import { usePromptComposer } from "@plugins/conversations/plugins/conversation-view/web";
import { GoCap, GoInlineUnit, sendIcon } from "./go-cap";
import { goDraft, goWire } from "../internal/parse-go";

/**
 * `<go>` beside prose: one unit, `[text | ▶]`, in the paragraph's flow. The
 * text is the edit half — click it to put the suggestion in the draft — and ▶
 * sends it. `content` is the markdown source between the tags — what is sent
 * back. Outside a conversation pane there is no prompt to reach, so only the
 * tinted text renders.
 */
export function GoInline({
  content,
  children,
}: {
  content: string;
  attrs: Record<string, string>;
  children: ReactNode;
}) {
  const composer = usePromptComposer();
  const wire = goWire(content, []);
  if (!composer) return <GoInlineUnit>{children}</GoInlineUnit>;
  return (
    <GoInlineUnit
      onEdit={() => composer.insert(goDraft(wire))}
      cap={
        <GoCap
          icon={sendIcon}
          label="Send"
          disabled={!composer.canSend}
          onAction={() => composer.send(wire)}
        />
      }
    >
      {children}
    </GoInlineUnit>
  );
}
