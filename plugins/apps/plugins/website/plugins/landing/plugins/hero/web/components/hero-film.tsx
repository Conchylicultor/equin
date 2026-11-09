import { useState } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { MediaPlayer } from "@plugins/media/plugins/player/web";
import { showcaseFilm } from "@plugins/apps/plugins/website/plugins/media/core";

/** The film's box: a 16:9 frame, capped narrower than the reading measure. */
const FRAME = "w-full max-w-[45rem] aspect-video rounded-xl";

/**
 * The showcase film, between the lede and the properties: the poster (a frame
 * of the film's desktop) with the player's own big play button, then the
 * themed player. Its bytes are the website-media mirror's (`apps/website/media`),
 * never git.
 *
 * The poster is decoration: until it resolves (or if it cannot) the player
 * shows the film's first frame instead, so only the film's own state is
 * rendered as one.
 */
export function HeroFilm() {
  const video = useAssetSrc(showcaseFilm.video);
  const poster = useAssetSrc(showcaseFilm.poster);
  const [failed, setFailed] = useState<string | null>(null);

  if (video.kind === "loading")
    return <Loading variant="block" className={FRAME} />;
  if (video.kind !== "ready") return <FilmProblem message={video.message} />;
  if (failed !== null) return <FilmProblem message={failed} />;
  return (
    <MediaPlayer
      kind="video"
      src={video.src}
      poster={poster.kind === "ready" ? poster.src : undefined}
      label={showcaseFilm.label}
      onError={(error) =>
        setFailed(
          `The film could not be played${error?.message ? `: ${error.message}` : "."}`,
        )
      }
      className={FRAME}
    />
  );
}

/** What stands in the film's frame when it cannot be shown, saying why. */
function FilmProblem({ message }: { message: string }) {
  return (
    <Center className={`${FRAME} border border-border`}>
      <Text tone="muted">{message}</Text>
    </Center>
  );
}
