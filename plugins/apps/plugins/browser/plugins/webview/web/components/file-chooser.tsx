import { useRef, useState, type DragEvent } from "react";
import type { HostEvent } from "@plugins/apps/plugins/browser/plugins/engine/core";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

export type FileChooserEvent = Extract<HostEvent, { t: "fileChooser" }>;

/** Bytes of an upload under way, as the host acks them. */
export interface UploadProgress {
  received: number;
  total: number;
}

const uploadIcon = symbol("upload");

/**
 * A page's file input asked for files. The picker cannot open by itself — the
 * ask arrived over a socket, and a browser opens a file picker only from a
 * user gesture — so this asks the user: choose files (a real `<input
 * type=file>` with the page's `multiple` / `accept`) or drop them here. Then
 * it shows the upload's progress until the page has them. Dismissing it before
 * a pick answers "no files", as closing a native chooser does.
 */
export function FileChooserPrompt({
  chooser,
  progress,
  onPick,
  onCancel,
}: {
  chooser: FileChooserEvent;
  /** `null` until files are picked. */
  progress: UploadProgress | null;
  onPick(files: File[]): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploading = progress !== null;
  const noun = chooser.multiple ? "files" : "a file";

  const pick = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    onPick(chooser.multiple ? files : files.slice(0, 1));
  };

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (!uploading) pick(e.dataTransfer.files);
  };

  const percent =
    progress === null || progress.total === 0
      ? 0
      : Math.round((progress.received / progress.total) * 100);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Bytes already on their way: the upload finishes on its own.
        if (!open && !uploading) onCancel();
      }}
    >
      <DialogContent size="sm">
        <Stack gap="md">
          <Stack gap="xs">
            <DialogTitle>
              {chooser.multiple ? "Upload files" : "Upload a file"}
            </DialogTitle>
            <DialogDescription>
              {uploading
                ? `Sending to the page… ${percent}%`
                : `This page asks for ${noun}${chooser.accept !== "" ? ` (${chooser.accept})` : ""}.`}
            </DialogDescription>
          </Stack>
          {uploading ? (
            <Clip axis="both" className="h-1 w-full rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </Clip>
          ) : (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={cn(
                "rounded-md border border-dashed border-border px-md py-lg text-muted-foreground transition-colors hover:bg-muted",
                dragOver && "border-primary bg-muted",
              )}
            >
              <Stack gap="xs" align="center">
                <Icon icon={uploadIcon} className="size-5" />
                <Text variant="body" tone="muted">
                  Drop {noun} here, or click to choose
                </Text>
              </Stack>
            </button>
          )}
          <Stack direction="row" align="center" gap="sm">
            <Fill />
            <Button variant="ghost" disabled={uploading} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              autoFocus
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {chooser.multiple ? "Choose files…" : "Choose file…"}
            </Button>
          </Stack>
        </Stack>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple={chooser.multiple}
          accept={chooser.accept !== "" ? chooser.accept : undefined}
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
