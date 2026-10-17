import { useCallback, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  Button,
  DialogTitle,
  DialogDescription,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  EndpointError,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import type { ConfirmDialogOptions } from "../internal/confirm-dialog";

type Props = ConfirmDialogOptions & {
  onClose: () => void;
  onConfirmed: () => void;
};

/**
 * Body of confirmDialog. Owns the error policy, because Button cannot: Button
 * auto-pends off a returned thenable but attaches only `.finally()`, so a rejected
 * onClick promise would escape as an unhandled rejection. runConfirm therefore
 * ALWAYS resolves (try/catch, no rethrow into Button). On failure it keeps the
 * dialog open and renders the message inline (the confirm button re-enables, so the
 * message IS the retry). A non-EndpointError also re-files the crash via
 * `void Promise.reject(err)` (fetchEndpoint already reported EndpointError to the
 * endpointErrorSink, so that one is only shown, not re-filed).
 *
 * ## Why the keyboard confirm takes a modifier
 *
 * ⌘/Ctrl+Enter confirms from anywhere in the dialog; a bare Enter deliberately
 * does not.
 *
 * Focus opens on Cancel, which is the right place for it — every action behind
 * this dialog is destructive, and the guidance for a destructive choice is that
 * it must not be the one a reflex reaches. A bare Enter would undo exactly that:
 * a person who hits Return out of habit, or who was typing when the dialog
 * appeared, would destroy the thing the dialog was asked to guard, with no undo.
 * So Enter keeps its plain meaning — activate whatever is focused, which is
 * Cancel — and the accelerator asks for a second key held down, which no reflex
 * supplies.
 *
 * It is bound here on the body rather than through the shortcut registry
 * because it must live and die with this one dialog, and only while it is the
 * thing the user is looking at.
 */
export function ConfirmDialogBody({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  children,
  onConfirm,
  onClose,
  onConfirmed,
}: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runConfirm = useCallback(async () => {
    setError(null);
    setPending(true);
    try {
      await onConfirm();
      onConfirmed();
      onClose();
    } catch (err) {
      setError(getEndpointErrorMessage(err));
      setPending(false);
      if (!(err instanceof EndpointError)) void Promise.reject(err);
    }
  }, [onConfirm, onConfirmed, onClose]);

  // Held-modifier + Enter, from anywhere inside the dialog. Guarded on `pending`
  // so a second press mid-request cannot fire the action twice.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || pending) return;
    e.preventDefault();
    void runConfirm();
  };

  return (
    <Stack gap="md" onKeyDown={onKeyDown}>
      <Stack gap="xs">
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </Stack>
      {children}
      {error && (
        <Text as="p" variant="body" tone="destructive" role="alert">
          {error}
        </Text>
      )}
      <Stack direction="row" align="center" gap="sm">
        <Fill />
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          {cancelLabel}
        </Button>
        {/* The tooltip is the whole of this accelerator's discoverability, and
            that is deliberate: the alternative is printing a key hint inside a
            destructive button, which adds noise to the one control that should
            read as a single unambiguous word. `formatShortcutLabel` spells the
            modifier the way THIS machine does (⌘ on a Mac, Ctrl elsewhere). */}
        <Button
          tooltip={<Kbd>{formatShortcutLabel("mod+enter")}</Kbd>}
          variant="destructive"
          onClick={runConfirm}
          loading={pending}
        >
          {confirmLabel}
        </Button>
      </Stack>
    </Stack>
  );
}
