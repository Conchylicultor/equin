import { useState } from "react";
import type { HostEvent } from "@plugins/apps/plugins/browser/plugins/engine/core";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

export type PageDialogEvent = Extract<HostEvent, { t: "dialog" }>;

const TITLES: Record<PageDialogEvent["type"], string> = {
  alert: "This page says",
  confirm: "This page asks",
  prompt: "This page asks",
  beforeunload: "Leave this page?",
};

/**
 * A page's JavaScript dialog (`alert` / `confirm` / `prompt` /
 * `beforeunload`), which blocks the remote page until answered. Dismissing it
 * (Escape, the ✕, a press outside) answers "cancel".
 */
export function PageDialog({
  dialog,
  onAnswer,
}: {
  dialog: PageDialogEvent;
  onAnswer(accept: boolean, promptText?: string): void;
}) {
  const [text, setText] = useState(dialog.defaultValue);
  const accept = () =>
    onAnswer(true, dialog.type === "prompt" ? text : undefined);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onAnswer(false);
      }}
    >
      <DialogContent size="sm">
        <Stack gap="md">
          <Stack gap="xs">
            <DialogTitle>{TITLES[dialog.type]}</DialogTitle>
            {dialog.message !== "" && (
              <DialogDescription>{dialog.message}</DialogDescription>
            )}
          </Stack>
          {dialog.type === "prompt" && (
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") accept();
              }}
            />
          )}
          <Stack direction="row" align="center" gap="sm">
            <Fill />
            {dialog.type !== "alert" && (
              <Button variant="ghost" onClick={() => onAnswer(false)}>
                {dialog.type === "beforeunload" ? "Stay" : "Cancel"}
              </Button>
            )}
            <Button autoFocus={dialog.type !== "prompt"} onClick={accept}>
              {dialog.type === "beforeunload" ? "Leave" : "OK"}
            </Button>
          </Stack>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
