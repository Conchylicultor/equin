import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  SonataDocument,
  useSongDocument,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { Library } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { compile } from "./compile";
import { ChordGridLoader } from "./loader";
import { CHORD_GRID_SOURCE_ID } from "./constants";
import { hydrate } from "./hydrate";
import { chordGridCreateOption } from "./components/chord-grid-create-option";
import { ChordGridEditorSection } from "./components/chord-grid-editor-section";
import { ChordGridPersistObserver } from "./components/chord-grid-persist-observer";
import { chordGridPresentation } from "./internal/presentation";
import { chordGridCover } from "./internal/cover";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Chord-grid input source for Sonata. A small mini-language (e.g. `Amaj9 Am9 (E E6)`) authors chord annotations: each cell is a bar, a `( )` group shares a bar, and `.` holds the previous chord. A cell may name a chord by letter (`Am7`) or by degree (`vi7`), the latter resolved against the key a `key:` directive declares. compile() emits chord + key annotations only; the shell's reactive re-voicing step generates the notes under the global voicing config. Persists per-song grid text and contributes the library 'New Chord Grid' affordance, hydration, the cell of the Chords field its extension exposes on every list of songs, the song cover (its first chords as degree-coloured chord boxes), and an in-player editor section.",
  contributions: [
    SonataDocument.Source({
      id: CHORD_GRID_SOURCE_ID,
      label: "Chord Grid",
      icon: symbol("grid-view"),
      LoaderComponent: ChordGridLoader,
      compile,
    }),
    Library.Source({
      sourceId: CHORD_GRID_SOURCE_ID,
      hydrate,
      createOption: chordGridCreateOption,
    }),
    Sonata.Section({
      id: "chord-grid-editor",
      label: "Chord Grid",
      icon: symbol("grid-view"),
      component: ChordGridEditorSection,
      area: "editor",
      useAvailable: () =>
        useSongDocument().sourceRaw(CHORD_GRID_SOURCE_ID) !== undefined,
    }),
    Sonata.Effect({
      id: "chord-grid-persist",
      component: ChordGridPersistObserver,
    }),
    chordGridPresentation,
    chordGridCover,
  ],
} satisfies PluginDefinition;
