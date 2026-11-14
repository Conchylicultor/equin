import { describe, expect, test } from "bun:test";
import type {
  Box,
  Setting,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";
import type { AppCategory } from "@plugins/primitives/plugins/pane/core";
import {
  EMPTY_PLACEMENT,
  placeResidents,
  plotById,
  signHalfWidth,
  type Resident,
} from "./placement";
import { plotsClash } from "./sites";
import { WorldModel } from "./world-model";

/** A building as its app declares it: the same footprint, setting and sign as placement reads. */
function building(
  id: string,
  name: string,
  category: AppCategory,
  setting: readonly Setting[],
  w: number,
  depth: number,
  ground: Box,
  upper: Box,
  signX: number,
): Resident {
  return {
    id,
    category,
    footprint: { w, depth, ground, upper },
    setting,
    signX,
    signHalf: signHalfWidth(name),
  };
}

// The 19 installed apps' buildings (bespoke ones by name, generated ones `kit-…`),
// in the rail's order, copied from their declarations — world/core names no app.
const TOWN: readonly Resident[] = [
  building(
    "kit-home",
    "Home",
    "life",
    ["square"],
    118,
    60,
    [-75, -112, 119, 43],
    [-75, -148, 75, -112],
    -79,
  ),
  building(
    "forge",
    "Agent Manager",
    "work",
    ["lane"],
    214,
    84,
    [-148, -112, 175, 39],
    [-119, -297, 120, -112],
    -138,
  ),
  building(
    "library",
    "Pages",
    "work",
    ["square", "lane"],
    232,
    96,
    [-155, -112, 188, 40],
    [-126, -232, 127, -112],
    -150,
  ),
  building(
    "music-hall",
    "Sonata",
    "music",
    ["square"],
    236,
    100,
    [-147, -112, 194, 39],
    [-128, -245, 129, -112],
    -152,
  ),
  building(
    "lighthouse",
    "Places",
    "life",
    ["coast", "cape"],
    150,
    84,
    [-129, -112, 158, 46],
    [-48, -315, 48, -112],
    -112,
  ),
  building(
    "inventors-cabin",
    "Prototypes",
    "create",
    ["forest"],
    196,
    72,
    [-152, -112, 174, 50],
    [-74, -249, 92, -112],
    -140,
  ),
  building(
    "archive-barn",
    "Files",
    "work",
    ["harbour", "shore"],
    210,
    80,
    [-152, -112, 178, 45],
    [-106, -189, 128, -112],
    -150,
  ),
  building(
    "schoolhouse",
    "Tap Tap Party",
    "play",
    ["lane", "square"],
    176,
    74,
    [-115, -112, 151, 44],
    [-77, -172, 93, -112],
    -130,
  ),
  building(
    "kit-desktop",
    "Desktop",
    "system",
    ["hill"],
    98,
    50,
    [-65, -112, 95, 44],
    [-63, -250, 63, -112],
    -75,
  ),
  building(
    "windmill",
    "Settings",
    "system",
    ["hill"],
    120,
    62,
    [-139, -112, 181, 46],
    [-158, -354, 158, -112],
    -112,
  ),
  building(
    "post-office",
    "Mail",
    "work",
    ["square"],
    206,
    84,
    [-144, -112, 169, 39],
    [-117, -214, 118, -112],
    140,
  ),
  building(
    "clock-tower",
    "Events",
    "life",
    ["square"],
    120,
    56,
    [-117, -112, 205, 34],
    [-46, -364, 82, -112],
    -105,
  ),
  building(
    "bandstand",
    "Chord",
    "music",
    ["square"],
    196,
    100,
    [-111, -112, 150, 39],
    [-93, -206, 93, -112],
    134,
  ),
  building(
    "observatory",
    "Browser",
    "data",
    ["hill"],
    184,
    104,
    [-112, -112, 152, 45],
    [-77, -238, 85, -112],
    128,
  ),
  building(
    "conservatory",
    "Studio",
    "create",
    ["forest"],
    230,
    78,
    [-141, -112, 176, 45],
    [-122, -173, 134, -112],
    -150,
  ),
  building(
    "kit-website",
    "equin",
    "life",
    ["square"],
    176,
    60,
    [-117, -112, 148, 43],
    [-102, -225, 102, -112],
    -114,
  ),
  building(
    "kit-demo",
    "Demo",
    "music",
    ["square"],
    166,
    60,
    [-135, -112, 127, 41],
    [-99, -217, 99, -112],
    109,
  ),
  building(
    "launch-tower",
    "Deploy",
    "system",
    ["cape", "coast"],
    200,
    88,
    [-132, -112, 191, 51],
    [-83, -375, 148, -112],
    -150,
  ),
  building(
    "kit-debug",
    "Debug",
    "system",
    ["hill"],
    116,
    50,
    [-87, -112, 104, 44],
    [-72, -264, 72, -112],
    -84,
  ),
];

describe("isle landmarks", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: the lighthouse stands on the coast, the windmill and the observatory on hills`, () => {
      const P = placeResidents(new WorldModel(seed), EMPTY_PLACEMENT, TOWN);
      const tags = (id: string) => {
        const p = plotById(P, P.occupant[id]);
        if (!p) throw new Error(`${id} has no plot`);
        return p.tags;
      };
      expect(
        tags("lighthouse").some((t) => t === "coast" || t === "cape"),
      ).toBe(true);
      expect(tags("windmill")).toContain("hill");
      expect(tags("observatory")).toContain("hill");
      const plots = TOWN.map((r) => plotById(P, P.occupant[r.id])!);
      for (let i = 0; i < plots.length; i++)
        for (let j = i + 1; j < plots.length; j++)
          if (plotsClash(plots[i]!, plots[j]!))
            throw new Error(
              `plots ${plots[i]!.id} and ${plots[j]!.id} overlap`,
            );
    }, 60_000);
  }
});
