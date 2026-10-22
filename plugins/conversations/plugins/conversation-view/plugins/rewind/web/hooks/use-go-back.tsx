import { useState } from "react";
import { useConversationById } from "@plugins/conversations/web";
import { normalizeModel } from "@plugins/conversations/plugins/model-provider/core";
import { useLaunchConversation } from "@plugins/primitives/plugins/launch/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import {
  getEndpointErrorMessage,
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import { useToast, type Toast } from "@plugins/shell/plugins/notifications/web";
import { previewRewindEndpoint, rewindConversationEndpoint } from "../../core";
import { LossList } from "../components/loss-list";
import { describeLosses, type RewindMode } from "../internal/describe-losses";

export type { RewindMode };

/**
 * Go back to just before one of the user's messages: in this conversation
 * (`"rewind"`) or in a new one (`"fork"`). Previews the cut, confirms first when
 * something cannot be brought back, and refuses with a toast.
 *
 * `onBack(conversationId, messageText)` runs once the target conversation stands
 * just before the message — `conversationId` is this conversation for a rewind
 * and the new one for a fork. The caller decides where the removed text goes
 * (the prompt editor, a question's answer form, …).
 *
 * `available` is false when there is nothing to go back to: no message uuid
 * (text that merely arrived in a user-role line) or no session to resume —
 * and on a host without the computer (the demo): the cut reads the agent's
 * transcript off it (`needsMachine`).
 */
export function useGoBackToMessage({
  convId,
  uuid,
  onBack,
}: {
  convId: string;
  uuid: string | undefined;
  onBack: (conversationId: string, messageText: string) => void;
}): {
  available: boolean;
  busy: boolean;
  run: (mode: RewindMode) => Promise<void>;
} {
  const conversation = useConversationById(convId);
  const fetchEndpoint = useFetchEndpoint();
  const machine = useMachineAvailability(previewRewindEndpoint);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The text to hand the FORK: known once the preview answers, used once the
  // new conversation exists.
  const [forkText, setForkText] = useState("");

  const { launch } = useLaunchConversation({
    getRequest: () => ({
      forkFromConversationId: convId,
      forkAtMessageUuid: uuid,
    }),
    onLaunched: (created) => onBack(created.id, forkText),
  });

  const available =
    machine.available && uuid != null && !!conversation?.claudeSessionId;

  const run = async (mode: RewindMode) => {
    if (!available || busy || uuid == null || !conversation?.claudeSessionId)
      return;
    const model = normalizeModel(conversation.model);

    const rewind = async () => {
      const result = await fetchEndpoint(
        rewindConversationEndpoint,
        { id: convId },
        { body: { uuid } },
      );
      if (result.kind === "unavailable") throw new Error(result.message);
      const outcome = result.value;
      if (!outcome.ok) throw new Error(outcome.message);
      onBack(convId, outcome.rewindText);
    };

    setBusy(true);
    try {
      const previewed = await fetchEndpoint(
        previewRewindEndpoint,
        { id: convId },
        { body: { uuid } },
      );
      if (previewed.kind === "unavailable")
        return refused(toast, previewed.message);
      const preview = previewed.value;
      if (!preview.ok) return refused(toast, preview.message);
      if (mode === "rewind" && !preview.inPlace) {
        return refused(
          toast,
          "This message predates a fork, so the conversation cannot be rewound to it in place. Fork from it instead.",
        );
      }
      setForkText(preview.messageText);
      const act = mode === "rewind" ? rewind : () => launch(model);
      const lines = describeLosses(preview, mode);
      if (lines.length === 0) return await act();
      void confirmDialog({
        title:
          mode === "rewind"
            ? "Rewind to this message?"
            : "Fork from this message?",
        description: preview.messageText.slice(0, 140),
        confirmLabel: mode === "rewind" ? "Rewind" : "Fork",
        children: <LossList lines={lines} />,
        onConfirm: act,
      });
    } catch (err) {
      refused(toast, getEndpointErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return { available, busy, run };
}

function refused(toast: Toast, message: string): void {
  toast({
    type: "conversation",
    title: "Cannot go back to this message",
    description: message,
    variant: "error",
  });
}
