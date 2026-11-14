import { useEffect, useState } from "react";
import { ISLE_FONTS } from "@plugins/apps/plugins/isle/plugins/renderer/web";

export type FontsState = "loading" | "ready" | { readonly error: Error };

/**
 * The faces the canvas writes in (Nunito for signposts, Fraunces for map
 * names), loaded: the theme names them so the font loader fetches them, and
 * the canvas waits on `document.fonts.load` before drawing any text.
 */
export function useIsleFonts(): FontsState {
  const [state, setState] = useState<FontsState>("loading");
  useEffect(() => {
    let live = true;
    void Promise.all(ISLE_FONTS.map((f) => document.fonts.load(f))).then(
      () => {
        if (live) setState("ready");
      },
      (err: unknown) => {
        if (live)
          setState({
            error: err instanceof Error ? err : new Error(String(err)),
          });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
