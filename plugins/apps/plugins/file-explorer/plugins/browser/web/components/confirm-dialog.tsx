import { useCallback, type ReactNode } from "react";
import {
  Button,
  DialogDescription,
  DialogTitle,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { useOpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";

/** One yes/no question: what it asks, and the button that says yes. */
export interface Confirmation {
  title: string;
  description: string;
  confirm: string;
  /** The yes is destructive (Delete, Overwrite): painted so. */
  destructive: boolean;
}

/**
 * This surface's yes/no question (in its render origin): resolves `true` only
 * on the confirm button — Cancel, Escape or a press outside are a no.
 */
export function useConfirm(): (question: Confirmation) => Promise<boolean> {
  const openDialog = useOpenDialog();
  return useCallback(
    (question) => {
      let yes = false;
      return openDialog(
        (close) => (
          <ConfirmBody
            {...question}
            onAnswer={(answer) => {
              yes = answer;
              close();
            }}
          />
        ),
        { size: "sm" },
      ).then(() => yes);
    },
    [openDialog],
  );
}

function ConfirmBody({
  title,
  description,
  confirm,
  destructive,
  onAnswer,
}: Confirmation & { onAnswer: (yes: boolean) => void }): ReactNode {
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </Stack>
      <Stack direction="row" align="center" gap="sm">
        <Fill />
        <Button variant="ghost" onClick={() => onAnswer(false)}>
          Cancel
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          autoFocus
          onClick={() => onAnswer(true)}
        >
          {confirm}
        </Button>
      </Stack>
    </Stack>
  );
}
