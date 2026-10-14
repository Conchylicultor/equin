/**
 * MusicXML file picker: choose a `.musicxml` / `.xml` file, check that it parses
 * and hand its text up via `onRaw`. A parse failure is shown in a
 * `role="alert"` line — never swallowed.
 */

import { useRef, useState } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { MusicXmlParseError, parseMusicXml } from "../shared/parse";
import { MUSICXML_ACCEPT } from "./constants";

interface Props {
  onRaw: (raw: unknown) => void;
}

export function MusicXmlLoader({ onRaw }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readFile = async (file: File) => {
    const xml = await file.text();
    try {
      parseMusicXml(xml);
    } catch (err) {
      if (!(err instanceof MusicXmlParseError)) throw err;
      setError(err.message);
      return;
    }
    setError(null);
    setFileName(file.name);
    onRaw(xml);
  };

  return (
    <Stack align="center" gap="md" className="p-lg">
      <Button onClick={() => inputRef.current?.click()}>
        {fileName ?? "Choose a MusicXML file"}
      </Button>
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
        accept={MUSICXML_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so the same file can be re-selected.
          e.target.value = "";
          if (file) void readFile(file);
        }}
      />
    </Stack>
  );
}
