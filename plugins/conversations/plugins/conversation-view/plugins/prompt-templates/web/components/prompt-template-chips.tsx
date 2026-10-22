import type { PromptEditorActionProps } from "@plugins/primitives/plugins/prompt-editor/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { canSendTurn } from "@plugins/conversations/core";
import {
  useSendConversationTurn,
  useTurnSendAvailability,
} from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { useConfig } from "@plugins/config_v2/web";
import { promptTemplatesConfig } from "../../shared/config";
import { TemplateChipBar } from "./template-chip-bar";
import type { TemplateChipItem } from "./template-chip";

export function FloatingTemplateChips({
  insertText,
  takeDraftWith,
}: PromptEditorActionProps) {
  const { convId } = conversationPane.useParams();
  // `useConversationById` answers with the live row (its by-id read).
  const live = useConversationById(convId);
  const { templates, pinnedCount } = useConfig(promptTemplatesConfig);
  const sendConversationTurn = useSendConversationTurn();
  const sendAvailability = useTurnSendAvailability();

  // The same gate the prompt input applies to Enter — a template send IS a turn
  // send, so the two must open and close together (canSendTurn, and a host
  // with the computer behind it).
  const canSend = sendAvailability.available && !!live && canSendTurn(live);

  // No in-flight state, no error toast: the turn send owns the echo
  // card, the retry affordance and the delivery report. The template goes in
  // through the same insert as ✎ — at the caret — and the editor is emptied in
  // the same step, mirroring the prompt input's own send.
  function sendTemplate(t: TemplateChipItem) {
    const text = takeDraftWith(t.prompt).trim();
    sendConversationTurn(convId, { text });
  }

  return (
    <TemplateChipBar
      templates={templates}
      pinnedCount={pinnedCount}
      usageNamespace="prompt-templates"
      freezeKey={convId}
      onInsert={(t) => insertText(t.prompt)}
      onSend={sendTemplate}
      host="row"
      canSend={canSend}
      config={promptTemplatesConfig}
      configLabel="Configure: Prompt templates"
    />
  );
}
