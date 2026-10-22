import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  uploadAttachment,
  type UploadedAttachment,
} from "@plugins/infra/plugins/attachments/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useBlockActivate } from "@plugins/page/plugins/editor/web";

// Turn an `accept` spec into a mime predicate: `"*"` → always; `"image/*"` →
// prefix match; an exact mime → equality.
function matchesAccept(accept: string, mime: string): boolean {
  if (accept === "*") return true;
  if (accept.endsWith("/*")) return mime.startsWith(accept.slice(0, -1));
  return mime === accept;
}

/**
 * Reusable empty-state upload funnel for attachment-owning page blocks. Owns
 * the click/drop/paste inputs, the uploading/error state, and validates the
 * file mime against `accept` before uploading via the attachments primitive.
 * The parent persists the result (e.g. via `editor.update`) from `onUploaded`.
 *
 * **It is not a focus target.** The block's caret host is: it is the focusable
 * box, it reports focus to the editor, and it answers the keyboard. This
 * dropzone used to be a second tab stop inside it (`role="button"`,
 * `tabIndex={0}`, its own Enter/Space handler, an `onArm` that re-reported the
 * focus already bubbling out of it) — one block the user had to Tab through
 * twice, with two things claiming to be "where the caret is". Enter/Space are
 * declared through {@link useBlockActivate} instead; a click still opens the
 * picker directly.
 */
export function AttachmentUpload({
  accept,
  label,
  icon,
  isFocused,
  onUploaded,
}: {
  accept: string;
  label: string;
  icon: IconRef;
  /**
   * Does the editor's caret sit on this block? Kept as a prop although the host
   * now owns focus: it arms the window `paste` listener below, which is
   * BEHAVIOUR (Cmd+V into an empty media block fills it), not a cue.
   */
  isFocused: boolean;
  onUploaded: (res: UploadedAttachment) => void;
}) {
  const fetchEndpoint = useFetchEndpoint();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Enter / Space on the block's caret host opens the file picker: an unfilled
  // media block is a PROMPT, so the block's primary action is to fill it. This
  // component is shared and also renders outside a caret host, where the hook is
  // a documented no-op — a caller never has to know which surface it is on.
  useBlockActivate(() => {
    if (!uploading) inputRef.current?.click();
  });

  // Funnel for all three inputs (picker / drop / paste). Validates the mime,
  // uploads via the attachments primitive, then hands the result to the parent.
  const ingest = useCallback(
    async (file: File | Blob) => {
      if (!matchesAccept(accept, file.type ?? "")) {
        setError("Unsupported file type.");
        return;
      }
      setError(null);
      setUploading(true);
      try {
        const filename = file instanceof File ? file.name : "file";
        const res = await uploadAttachment(
          fetchEndpoint,
          file,
          filename,
          file.type,
        );
        onUploaded(res);
      } catch (e) {
        // Fail loud — surface the upload error, never swallow it.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [accept, onUploaded, fetchEndpoint],
  );

  // Paste listener, armed only while this empty block is focused. Keyed by the
  // editor's existing focus model so at most one block's listener is live.
  useEffect(() => {
    if (!isFocused) return;
    function onPaste(e: ClipboardEvent) {
      const items = Array.from(e.clipboardData?.items ?? []).filter(
        (it) => it.kind === "file" && matchesAccept(accept, it.type),
      );
      const item = items.find((it) => it.type === "image/png") ?? items[0];
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      void ingest(file);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [isFocused, accept, ingest]);

  return (
    <div className="px-md py-xs">
      <input
        ref={inputRef}
        type="file"
        accept={accept === "*" ? undefined : accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so the same file can be re-selected later.
          e.target.value = "";
          if (file) void ingest(file);
        }}
      />
      {error ? <Placeholder tone="error">{error}</Placeholder> : null}
      <Stack
        as="div"
        direction="row"
        align="center"
        gap="sm"
        onClick={() => {
          if (!uploading) inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          // Claim the drag: this empty block fills itself in place, so don't let
          // the event bubble to the editor's container drop handler (which would
          // otherwise also create a new attachment block alongside).
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void ingest(file);
        }}
        className={cn(
          "cursor-pointer rounded-md border border-dashed border-border px-md py-lg text-body text-muted-foreground transition-colors hover:bg-muted",
          dragOver && "border-primary bg-muted",
        )}
      >
        <Icon icon={icon} className="size-4" />
        <span>{uploading ? "Uploading…" : label}</span>
      </Stack>
    </div>
  );
}
