import { useForegroundMusic } from "@plugins/music/plugins/background/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";

/**
 * A song playing is real music: it pauses the background music service's
 * music where nobody sees its app (Isle's ambience kept across apps), and
 * every other browser tab's. Music beside it on the desktop mixes.
 */
export function BackgroundMusicYield(): null {
  const { isPlaying } = useSession();
  useForegroundMusic(isPlaying);
  return null;
}
