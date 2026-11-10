import { useLayoutEffect, useMemo } from "react";
import { familyGlyphMarkup } from "../../core";
import { Icons } from "../slots";
import { provideIconFamilies, useIconFamilies } from "./family-store";
import { SymbolSheet, type SheetEntry } from "./symbol-sheet";
// The motion keyframes and region rules, shipped wherever icons are.
import "./icon-motion.css";

/**
 * Publishes every `Icons.Family` contribution to the family store and renders
 * the app-drawn families' glyphs into the page (`SymbolSheet`: out of every
 * style recalc, their active forms' masks rendered), so `<use href>` resolves
 * in-document (portals and Fullscreen subtrees included).
 *
 * A layout effect: icons that rendered before the families were held
 * re-render before the browser paints, so a family's scope never flashes its
 * fallback drawing.
 */
export function IconFamilyHost() {
  const contributed = Icons.Family.useContributions();
  useLayoutEffect(() => {
    provideIconFamilies(contributed.map((c) => c.family));
  }, [contributed]);
  const families = useIconFamilies();
  const entries = useMemo(
    (): SheetEntry[] =>
      families.flatMap((family) =>
        family.kind === "inline"
          ? [
              {
                key: family.id,
                // Glyph bodies are source-code data, checked to hold shape
                // elements only when the family was defined — never user markup.
                markup: familyGlyphMarkup(family),
                attribute: "data-icon-family" as const,
              },
            ]
          : [],
      ),
    [families],
  );
  return <SymbolSheet entries={entries} attribute="data-icon-families" />;
}
