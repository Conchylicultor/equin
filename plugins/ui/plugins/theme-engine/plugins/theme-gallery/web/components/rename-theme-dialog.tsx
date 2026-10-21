import { useState } from "react";
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
import type { Theme } from "@plugins/ui/plugins/theme-engine/core";
import { renameSavedTheme } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/core";
import { awaitSavedThemesWrite } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/web";

/**
 * The rename dialog's body (opened through `openDialog`, which owns the
 * panel). A failed save keeps the dialog open with the message inline, so the
 * message is the retry — the same policy as `confirmDialog`.
 */
export function RenameThemeDialog({
  theme,
  onClose,
}: {
  theme: Theme;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(theme.label);
  const [error, setError] = useState<string | null>(null);
  const rename = useEndpointMutation(renameSavedTheme);
  const next = label.trim();
  const canSave = next.length > 0 && next !== theme.label;

  // Always resolves: Button auto-pends on the returned promise but attaches
  // only `.finally()`, so a rejection handed back to it would escape unhandled.
  const save = async () => {
    if (!canSave) return;
    setError(null);
    try {
      const { watermark } = await rename.mutateAsync({
        params: { id: theme.id },
        body: { label: next },
      });
      // Close once the live list carries the new label, so the gallery row
      // behind the dialog never shows the old one after it closes.
      await awaitSavedThemesWrite(watermark);
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
      <DialogTitle>Rename theme</DialogTitle>
      <Input
        value={label}
        autoFocus
        aria-label="Theme name"
        onChange={(e) => setLabel(e.target.value)}
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
        <Button variant="ghost" onClick={onClose} disabled={rename.isPending}>
          Cancel
        </Button>
        <Button onClick={save} disabled={!canSave}>
          Rename
        </Button>
      </Stack>
    </Stack>
  );
}
