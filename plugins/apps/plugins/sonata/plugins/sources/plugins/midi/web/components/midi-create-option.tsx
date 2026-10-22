import {
  openSongImperative,
  type SourceCreateOption,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { importMidiBytes } from "../import-midi";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const uploadIcon = symbol("upload");

/**
 * Pick a single file imperatively (no rendered `<input>`): create a transient
 * file input, click it, and resolve with the chosen file (or `null` if the user
 * cancels). Lets the create affordance live as plain data — a create option has
 * no component to host a hidden input.
 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
    };
    input.click();
  });
}

/**
 * The MIDI source's create affordance, contributed to `Library.Source` and
 * mapped by the library into the data-view `creators` "+" menu. Imports a `.mid`
 * file: pick a file imperatively, import its bytes (`importMidiBytes`: parse
 * for metadata, upload, create the MIDI-backed song), then open it immediately
 * (via the imperative `openSongImperative`). Fully imperative — no React hooks:
 * the library hands it the surface's fetcher.
 */
export const midiCreateOption: SourceCreateOption = {
  id: "midi",
  label: "Import MIDI",
  description: "Upload a .mid file to play and visualize it.",
  icon: <Icon icon={uploadIcon} className="size-4" />,
  onSelect: async ({ fetchEndpoint }) => {
    const file = await pickFile(".mid,.midi");
    if (!file) return;
    // `importMidiBytes` parses the file for its metadata and throws loudly on
    // malformed MIDI — we let it propagate.
    const song = await importMidiBytes(
      fetchEndpoint,
      await file.arrayBuffer(),
      file.name,
    );
    openSongImperative(song);
  },
};
