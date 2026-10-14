import type { CreateOption } from "@plugins/primitives/plugins/data-view/web";
import { openSongImperative } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { importMusicXmlFile } from "../import-musicxml";
import { MUSICXML_ACCEPT } from "../constants";

const uploadIcon = symbol("upload");

/** Pick a single file imperatively; resolves `null` when the user cancels. */
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
 * The MusicXML source's create affordance in the library "+" menu: pick a
 * `.musicxml` / `.xml` file, import it (parse, upload, create the song) and open
 * it. A malformed document throws loudly from `importMusicXmlFile`.
 */
export const musicXmlCreateOption: CreateOption = {
  id: "musicxml",
  label: "Import MusicXML",
  description: "Upload a .musicxml file (MuseScore, Dorico, Sibelius export).",
  icon: <Icon icon={uploadIcon} className="size-4" />,
  onSelect: async () => {
    const file = await pickFile(MUSICXML_ACCEPT);
    if (!file) return;
    openSongImperative(await importMusicXmlFile(file));
  },
};
