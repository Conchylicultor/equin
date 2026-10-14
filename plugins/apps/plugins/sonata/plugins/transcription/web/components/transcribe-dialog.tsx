import { useRef, useState } from "react";
import {
  Button,
  DialogDescription,
  DialogTitle,
  Input,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { openSongImperative } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { transcribeSong } from "../../shared/endpoints";
import type { TranscriptionInput } from "../../shared/input";

const uploadFileIcon = symbol("upload-file");

/** What the file picker and the drop zone accept: page images and PDFs. */
const ACCEPT = "image/*,.pdf,application/pdf";

function acceptable(file: File): boolean {
  return file.type.startsWith("image/") || /\.pdf$/i.test(file.name);
}

/**
 * The "Transcribe…" dialog, rendered inside the imperative-dialog host: a link
 * to a video or post showing sheet music, or page images / PDFs dropped in
 * order. Transcribe uploads the files, starts the transcription and opens the
 * new song, which shows as transcribing until the agent submits its score.
 * Failures stay in the dialog in a `role="alert"` line.
 */
export function TranscribeDialog({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addFiles = (list: FileList) => {
    const picked = [...list];
    const rejected = picked.filter((f) => !acceptable(f));
    if (rejected.length > 0) {
      setError(
        `Not an image or PDF: ${rejected.map((f) => f.name).join(", ")}`,
      );
      return;
    }
    setError(null);
    setFiles((prev) => [...prev, ...picked]);
  };

  const trimmed = url.trim();
  const ready = files.length > 0 || trimmed.length > 0;

  const submit = async () => {
    setError(null);
    try {
      let input: TranscriptionInput;
      if (files.length > 0) {
        const ups = [];
        for (const f of files) {
          ups.push(
            await uploadAttachment(f, f.name, f.type || "application/pdf"),
          );
        }
        input = { kind: "files", attachmentIds: ups.map((u) => u.id) };
      } else {
        input = { kind: "url", url: trimmed };
      }
      const song = await fetchEndpoint(transcribeSong, {}, { body: { input } });
      onClose();
      openSongImperative(song);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Stack gap="md">
      <Stack gap="2xs">
        <DialogTitle>Transcribe sheet music</DialogTitle>
        <DialogDescription>
          Paste a link to a video or post that shows a score, or drop photos or
          PDF pages. An agent writes it out as a song you can play.
        </DialogDescription>
      </Stack>

      <Input
        autoFocus
        value={url}
        disabled={files.length > 0}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ready) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="https://www.instagram.com/p/…"
        spellCheck={false}
      />

      <Stack
        role="button"
        tabIndex={0}
        aria-label="Drop page images or PDFs, or click to browse"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        align="center"
        gap="sm"
        className={cn(
          "rounded-xl border-2 border-dashed px-lg py-xl transition-colors",
          dragging
            ? "border-primary bg-primary/5"
            : "border-border hover:border-muted-foreground/50 hover:bg-muted/30",
        )}
      >
        <Icon icon={uploadFileIcon} className="size-8 text-muted-foreground" />
        <Text variant="label">
          {files.length > 0
            ? files.map((f) => f.name).join(", ")
            : "Or drop page images / PDFs here"}
        </Text>
        <Text variant="caption" tone="muted">
          In page order — or click to browse
        </Text>
      </Stack>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          // Reset so the same file can be picked again.
          e.target.value = "";
        }}
      />

      {error ? (
        <Text variant="caption" tone="destructive" role="alert">
          {error}
        </Text>
      ) : null}

      <Stack direction="row" gap="sm" justify="end">
        {files.length > 0 ? (
          <Button variant="ghost" onClick={() => setFiles([])}>
            Clear files
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!ready} onClick={submit}>
          Transcribe
        </Button>
      </Stack>
    </Stack>
  );
}
