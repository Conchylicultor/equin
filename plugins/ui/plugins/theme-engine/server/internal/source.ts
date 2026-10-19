import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { Theme } from "../../core";

/**
 * Themes beyond the code ones, as the server reads them — the twin of the web
 * `ThemeEngine.ThemeSource`'s `resident` kind (saved-themes contributes both).
 * Theme-engine names no source.
 */
export interface ServerThemeSource {
  id: string;
  list(): Promise<Theme[]>;
  /** Hear that `list` would answer differently now. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

export const ThemeEngine = {
  Source: defineServerContribution<ServerThemeSource>("ThemeEngine.Source", {
    docLabel: (c) => c.id,
  }),
};
