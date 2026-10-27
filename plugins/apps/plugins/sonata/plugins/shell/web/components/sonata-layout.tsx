import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";
import { SonataPlayerScope } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { Sonata } from "../slots";

/**
 * Sonata's app surface. Sonata is a pure full-surface app: the sidebar-less
 * app shell around the full-pane renderer, so the active pane (the library
 * index at `/sonata` or the player at `/sonata/song/:songId`) fills the whole
 * surface and its header — the surface's top chrome — carries the app
 * launcher at its leading edge. Navigation is URL-driven via the pane router —
 * reload / back / forward all persist.
 *
 * The whole surface is ONE player scope (`SonataPlayerScope`: the cursor, the
 * loaded song document, the playback session, the player view, the per-session
 * effects and the per-song setting observers), so each Sonata surface (desktop
 * window / keep-alive tab) gets its own isolated playback state, and a song
 * played from the library keeps playing whichever pane is active. Inside it,
 * the app-only providers (`Sonata.Provider`: the library's background play)
 * around everything, and the app-only effects (`Sonata.Effect`: shortcuts,
 * play history, source persistence).
 */
export function SonataLayout() {
  return (
    <SonataPlayerScope>
      <Sonata.Provider.Wrap>
        <div className="h-full min-h-0">
          <AppShellLayout>
            <FullPane />
          </AppShellLayout>
          <Sonata.Effect.Mount />
        </div>
      </Sonata.Provider.Wrap>
    </SonataPlayerScope>
  );
}
