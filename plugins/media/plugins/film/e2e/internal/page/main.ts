// The film page's entry (bundled as an IIFE by the host, see ../serve.ts):
// fetches the composition, builds the renderer and exposes it as
// `window.__film` for the render loop to drive.

import type { Composition } from "../composition";
import type { SfxCue } from "../cues";
import { installRenderer } from "./renderer";
import { renderSfx } from "./sfx";

export interface FilmWindowApi {
  /** Resolves once every image is decoded and every font loaded; throws on any failure. */
  ready(): Promise<void>;
  /** Paints film time t and waits two frames, so the next screenshot shows it. */
  renderAt(t: number): Promise<void>;
  renderSfx(cues: readonly SfxCue[], duration: number): Promise<string>;
}

const api: FilmWindowApi = {
  async ready() {
    const res = await fetch("/__film/composition.json");
    if (!res.ok) throw new Error(`film: composition.json HTTP ${res.status}`);
    const comp = (await res.json()) as Composition;
    const page = installRenderer(comp);
    await page.ready();
    api.renderAt = (t) => page.renderAt(t);
  },
  renderAt() {
    throw new Error("film: renderAt before ready()");
  },
  renderSfx,
};
(window as unknown as { __film: FilmWindowApi }).__film = api;
