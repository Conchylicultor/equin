import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { Library } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { parseMusicXml } from "../shared/parse";
import { MUSICXML_SOURCE_ID } from "./constants";
import { hydrate } from "./hydrate";
import { MusicXmlLoader } from "./loader";
import { musicXmlCreateOption } from "./components/musicxml-create-option";

export default {
  description:
    "MusicXML file input source for Sonata: compile() parses a score-partwise document into a Score (parts and staves as tracks, ties merged, repeats unrolled, chord symbols, tempo, swing). Persists per-song MusicXML as an attachment and contributes the library Import affordance and hydration.",
  contributions: [
    SonataDocument.Source({
      id: MUSICXML_SOURCE_ID,
      label: "MusicXML",
      icon: symbol("music-note"),
      LoaderComponent: MusicXmlLoader,
      compile: parseMusicXml,
    }),
    Library.Source({
      sourceId: MUSICXML_SOURCE_ID,
      hydrate,
      createOption: musicXmlCreateOption,
    }),
  ],
} satisfies PluginDefinition;
