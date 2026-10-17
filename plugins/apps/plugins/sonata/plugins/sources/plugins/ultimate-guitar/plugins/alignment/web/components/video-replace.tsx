import { useState } from "react";
import { youtubeThumbnailUrl } from "@plugins/integrations/plugins/youtube/core";
import {
  Button,
  Input,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  resolveUgAlignment,
  setUgAlignmentVideo,
  type AlignmentCandidate,
} from "../../core";
import { candidateTitle } from "../internal/recording-state";
import { useInlineAction } from "../internal/use-inline-action";
import { ChipBadge, outcomeChip } from "./outcome-chip";

const watchUrl = (videoId: string) =>
  `https://www.youtube.com/watch?v=${videoId}`;

/**
 * One candidate: thumbnail, title over channel, and what trying it came to.
 * A click makes it the song's video (the user's pick from then on); the current
 * video and one YouTube will not embed cannot be picked. Hovering reveals a
 * link opening it on YouTube.
 */
function CandidateRow({
  candidate,
  current,
  onPick,
}: {
  candidate: AlignmentCandidate;
  current: boolean;
  onPick: () => void;
}) {
  const title = candidateTitle(candidate, candidate.videoId);
  return (
    <Line
      className={cn(
        hoverRevealGroup,
        "gap-2xs rounded-md hover:bg-hover-fill",
        current && "bg-muted",
      )}
    >
      <button
        type="button"
        onClick={onPick}
        disabled={current || candidate.outcome === "not-embeddable"}
        aria-current={current ? "true" : undefined}
        title={current ? undefined : `Use ${title}`}
        className={cn(
          fillClasses("x"),
          "rounded-md px-xs py-2xs text-left disabled:cursor-default",
        )}
      >
        <Line className="gap-sm">
          <img
            src={youtubeThumbnailUrl(candidate.videoId, "default")}
            alt=""
            loading="lazy"
            className={cn(
              rigidClass(),
              "aspect-video w-12 rounded-sm bg-muted object-cover",
            )}
          />
          <Fill>
            <Stack gap="none">
              <Line>
                <Text variant="label">{title}</Text>
              </Line>
              {candidate.channel !== null ? (
                <Line>
                  <Text variant="caption" tone="muted">
                    {candidate.channel}
                  </Text>
                </Line>
              ) : null}
            </Stack>
          </Fill>
          <span className={rigidClass()}>
            <ChipBadge chip={outcomeChip(candidate)} />
          </span>
        </Line>
      </button>
      <NewTabButton
        href={watchUrl(candidate.videoId)}
        label="Open on YouTube"
        className={hoverRevealTarget}
      />
    </Line>
  );
}

/**
 * Replace the song's video, inline under its line: a YouTube link (prefilled
 * with the current video's) and Use, then the resolver's candidates to pick
 * from, and Search again (forget them and the current video, and let the
 * resolver find one afresh). `onDone` closes it once a video is set.
 */
export function VideoReplace({
  songId,
  videoId,
  candidates,
  onDone,
}: {
  songId: string;
  /** The song's chosen video (the current one), or null. */
  videoId: string | null;
  candidates: readonly AlignmentCandidate[];
  onDone: () => void;
}) {
  const [url, setUrl] = useState(videoId === null ? "" : watchUrl(videoId));
  const { error, run } = useInlineAction();
  // Errors are shown inline under the field (a bad link is a 400), so the
  // global toast is suppressed.
  const setVideo = useEndpointMutation(setUgAlignmentVideo, {
    meta: { suppressError: true },
  });
  const resolve = useEndpointMutation(resolveUgAlignment, {
    meta: { suppressError: true },
  });

  const use = async (link: string) => {
    const ok = await run(() =>
      setVideo.mutateAsync({ params: { id: songId }, body: { url: link } }),
    );
    if (ok) onDone();
  };
  const searchAgain = async () => {
    const ok = await run(() => resolve.mutateAsync({ params: { id: songId } }));
    if (ok) onDone();
  };
  const canUse = url.trim().length > 0;

  return (
    <Stack gap="sm">
      <Stack direction="row" align="center" gap="xs">
        <Fill>
          <Input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canUse) {
                e.preventDefault();
                void use(url.trim());
              }
            }}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="YouTube link"
            spellCheck={false}
          />
        </Fill>
        <Button onClick={() => void use(url.trim())} disabled={!canUse}>
          Use
        </Button>
      </Stack>
      {error !== null ? (
        <Text variant="caption" tone="destructive" role="alert">
          {error}
        </Text>
      ) : null}
      {candidates.length > 0 ? (
        <Stack gap="none">
          {candidates.map((c) => (
            <CandidateRow
              key={c.videoId}
              candidate={c}
              current={c.videoId === videoId}
              onPick={() => void use(c.videoId)}
            />
          ))}
        </Stack>
      ) : null}
      <Button
        variant="ghost"
        className={selfClass("start")}
        onClick={() => void searchAgain()}
      >
        Search again
      </Button>
    </Stack>
  );
}
