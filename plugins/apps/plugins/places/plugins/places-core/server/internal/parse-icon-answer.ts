import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";

export type IconAnswer =
  { ok: true; icon: SavedSymbolName } | { ok: false; reason: string };

function lineValue(out: string, label: string): string | undefined {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, "im");
  return re.exec(out)?.[1];
}

// One answer line's value as an installed symbol name. The model writes Google
// Fonts' spelling (`local_cafe`); the installed sets use dashes (`local-cafe`).
function symbolOf(value: string | undefined): SavedSymbolName | undefined {
  if (value === undefined) return undefined;
  const name = value
    .trim()
    .replace(/^[`"']+|[`"'.]+$/g, "")
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  return isSavedSymbolName(name) ? name : undefined;
}

/**
 * The model's `ICON:` / `ALT:` answer → the icon to write: ICON when it names an
 * installed Material Symbol, else ALT. With neither usable the answer is
 * unusable, and nothing is written.
 */
export function parseIconAnswer(out: string): IconAnswer {
  const icon =
    symbolOf(lineValue(out, "ICON")) ?? symbolOf(lineValue(out, "ALT"));
  if (icon === undefined) {
    return {
      ok: false,
      reason: `no Material Symbols name in answer: ${JSON.stringify(out.slice(0, 200))}`,
    };
  }
  return { ok: true, icon };
}
