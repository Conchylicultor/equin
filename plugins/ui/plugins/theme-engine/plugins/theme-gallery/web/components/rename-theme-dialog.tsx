import { useState } from "react";
import {
  Button,
  DialogTitle,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import type { Theme } from "@plugins/ui/plugins/theme-engine/core";
import { renameSavedTheme } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/core";

/**
 * The rename dialog's body (opened through `openDialog`, which owns the
 * panel). The rename is a predicted write: the gallery row reads the new label
 * at once, so the dialog closes on Rename; a refusal is reported by the live
 * write sink.
 */
export function RenameThemeDialog({
  theme,
  onClose,
}: {
  theme: Theme;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(theme.label);
  const rename = useLiveMutation(renameSavedTheme, { label: "Theme" });
  const next = label.trim();
  const canSave = next.length > 0 && next !== theme.label;

  const save = () => {
    if (!canSave) return;
    rename.mutate({ params: { id: theme.id }, body: { label: next } });
    onClose();
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
          if (e.key === "Enter") save();
        }}
      />
      <Stack direction="row" align="center" gap="sm">
        <Fill />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={!canSave}>
          Rename
        </Button>
      </Stack>
    </Stack>
  );
}
