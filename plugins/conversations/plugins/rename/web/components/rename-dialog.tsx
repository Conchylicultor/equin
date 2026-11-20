import { useState, type ReactElement } from "react";
import {
  Button,
  DialogTitle,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  EndpointError,
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import { z } from "zod";
import { CONVERSATION_TITLE_MAX, renameConversation } from "../../core";

const renameDraft = defineKept({
  owner: "conversations.rename",
  label: "Conversation rename drafts",
  tier: "work",
  stamp: "nl1v68s27p",
  cap: "8 KB",
  schema: z.string(),
});

/**
 * The rename dialog's body (opened through `openDialog`, which owns the
 * panel). A failed save keeps the dialog open with the message inline, so the
 * message is the retry.
 */
export function RenameConversationDialog({
  id,
  title,
  onClose,
}: {
  id: string;
  title: string;
  onClose: () => void;
}): ReactElement {
  const titleKept = useKept(renameDraft, title, { subject: id });
  const [draft, , clearDraft] = titleKept;
  const [error, setError] = useState<string | null>(null);
  const rename = useEndpointMutation(renameConversation);
  const next = draft.trim();
  const canSave =
    next.length > 0 && next.length <= CONVERSATION_TITLE_MAX && next !== title;

  // Always resolves: Button auto-pends on the returned promise but attaches
  // only `.finally()`, so a rejection handed back to it would escape unhandled.
  const save = async () => {
    if (!canSave) return;
    setError(null);
    try {
      await rename.mutateAsync({ params: { id }, body: { title: next } });
      clearDraft();
      onClose();
    } catch (err) {
      setError(getEndpointErrorMessage(err));
      // An EndpointError was already reported by the endpoint layer; anything
      // else is a bug and goes to the crash reporter.
      if (!(err instanceof EndpointError)) void Promise.reject(err);
    }
  };

  return (
    <Stack gap="md">
      <DialogTitle>Rename conversation</DialogTitle>
      <Input
        keep={titleKept}
        autoFocus
        maxLength={CONVERSATION_TITLE_MAX}
        aria-label="Conversation title"
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
        }}
      />
      {error && (
        <Text as="p" variant="body" tone="destructive" role="alert">
          {error}
        </Text>
      )}
      <Stack direction="row" align="center" gap="sm">
        <Fill />
        <Button
          variant="ghost"
          onClick={() => {
            clearDraft();
            onClose();
          }}
          disabled={rename.isPending}
        >
          Cancel
        </Button>
        <Button onClick={save} disabled={!canSave}>
          Rename
        </Button>
      </Stack>
    </Stack>
  );
}
