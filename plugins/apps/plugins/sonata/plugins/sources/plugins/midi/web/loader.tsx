/**
 * MIDI file dropzone.
 *
 * Accepts .mid / .midi files via drag-and-drop or a file-input click.
 * Reads the file as an ArrayBuffer and calls `onRaw(arrayBuffer)`.
 * Errors are surfaced visibly — never swallowed.
 */

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, useRef, useState } from "react";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const musicNoteIcon = symbol("music-note");
const uploadFileIcon = symbol("upload-file");

interface Props {
  onRaw: (raw: unknown) => void;
}

export function MidiLoader({ onRaw }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readFile = useCallback(
    (file: File) => {
      if (!file.name.match(/\.midi?$/i)) {
        setError(`Not a MIDI file: ${file.name}`);
        return;
      }
      setError(null);
      setFileName(file.name);
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (!(result instanceof ArrayBuffer)) {
          throw new Error(
            "[midi source] FileReader did not return ArrayBuffer",
          );
        }
        onRaw(result);
      };
      reader.onerror = () => {
        throw new Error(`[midi source] Failed to read file: ${file.name}`);
      };
      reader.readAsArrayBuffer(file);
    },
    [onRaw],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) readFile(file);
    },
    [readFile],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) readFile(file);
      // Reset so the same file can be re-selected.
      e.target.value = "";
    },
    [readFile],
  );

  return (
    <Stack align="center" gap="md" className="p-lg">
      <Stack
        role="button"
        tabIndex={0}
        aria-label="Drop a MIDI file or click to browse"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        align="center"
        gap="md"
        className={cn(
          "w-full max-w-sm rounded-xl border-2 border-dashed px-xl py-2xl transition-colors",
          dragging
            ? "border-primary bg-primary/5"
            : "border-border hover:border-muted-foreground/50 hover:bg-muted/30",
        )}
      >
        <Icon icon={uploadFileIcon} className="size-10 text-muted-foreground" />
        <Stack gap="2xs" className="text-center">
          <Text as="p" variant="label">
            {fileName ?? "Drop a MIDI file here"}
          </Text>
          <Text as="p" variant="caption" className="text-muted-foreground">
            .mid / .midi — or click to browse
          </Text>
        </Stack>
        {fileName ? (
          <Text
            as="div"
            variant="caption"
            className="rounded-md bg-muted px-sm py-xs text-muted-foreground"
          >
            <Line className="gap-xs">
              <Icon
                icon={musicNoteIcon}
                className={cn("size-3.5", rigidClass())}
              />
              <Text className="max-w-[16rem]">{fileName}</Text>
            </Line>
          </Text>
        ) : null}
      </Stack>

      {error ? (
        <Text
          as="p"
          variant="caption"
          className="text-destructive"
          role="alert"
        >
          {error}
        </Text>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept=".mid,.midi,audio/midi,audio/x-midi"
        className="hidden"
        onChange={handleChange}
      />
    </Stack>
  );
}
