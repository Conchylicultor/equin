import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { ICON_MANIFEST } from "./icon-manifest.generated";

/**
 * Every Material name some code draws (`symbol("…")`, the build's icon
 * manifest), as names a drawer takes — for a host that pre-draws them (a
 * browser host's warm-up), so a demo's chrome is drawn from the host's
 * storage rather than its whole bundled set.
 */
export function codeSymbolNames(): readonly SavedSymbolName[] {
  return ICON_MANIFEST.symbols.map(parseSavedSymbolName);
}
