import { useLayoutEffect } from "react";
import { familyGlyphMarkup } from "../../core";
import { Icons } from "../slots";
import { provideIconFamilies, useIconFamilies } from "./family-store";

/**
 * Publishes every `Icons.Family` contribution to the family store and renders
 * the app-drawn families' glyphs into the page, hidden, so `<use href>`
 * resolves in-document (portals and Fullscreen subtrees included).
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
  return (
    <div hidden data-icon-families="">
      {families.map((family) =>
        family.kind === "inline" ? (
          <div
            key={family.id}
            data-icon-family={family.id}
            // Glyph bodies are source-code data, checked to hold shape
            // elements only when the family was defined — never user markup.
            dangerouslySetInnerHTML={{ __html: familyGlyphMarkup(family) }}
          />
        ) : null,
      )}
    </div>
  );
}
