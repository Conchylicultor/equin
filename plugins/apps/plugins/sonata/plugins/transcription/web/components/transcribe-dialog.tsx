import { useRef } from "react";
import { DialogTitle } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { LaunchAgentForm } from "@plugins/primitives/plugins/launch/web";
import { workspaceLaunchOption } from "@plugins/conversations/plugins/workspace/plugins/launch-option/core";
import { openSongImperative } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { prepareTranscription } from "../../shared/endpoints";

/** The transcription decides where its agent runs; the user does not. */
const OWNED_OPTIONS = [workspaceLaunchOption];

/**
 * The "Transcribe…" dialog: the standard launch-agent form, so the request is
 * free text — a link to a video or post, instructions, page photos and PDFs
 * pasted or dropped straight into the field — with the usual launch options
 * (model, thinking mode, preprompt…). Launch prepares the song and its task
 * (`prepareTranscription`, which pins the transcription workspace) and starts
 * it through the standard task launch; the new song opens and shows as
 * transcribing until the agent submits its score.
 */
export function TranscribeDialog({ onClose }: { onClose: () => void }) {
  // The song `getRequest` prepared, opened once the launch is filed.
  const prepared = useRef<{ id: string; title: string } | null>(null);
  return (
    <>
      {/* The form prints its own heading; this names the dialog. */}
      <DialogTitle className="sr-only">Transcribe sheet music</DialogTitle>
      <LaunchAgentForm
        draftKey="sonata-transcribe"
        title="Transcribe sheet music"
        description="Paste a link to a video or post that shows a score, or paste or drop photos and PDF pages — add any instructions. An agent writes it out as a song you can play."
        placeholder="https://www.instagram.com/p/… — or paste page images / PDFs"
        textRequired
        ownedOptions={OWNED_OPTIONS}
        getRequest={async (text) => {
          const res = await fetchEndpoint(
            prepareTranscription,
            {},
            { body: { text } },
          );
          prepared.current = res.song;
          return { prompt: res.prompt, taskId: res.taskId };
        }}
        onSubmitted={() => {
          const song = prepared.current;
          if (!song) throw new Error("[transcription] launched without a song");
          onClose();
          openSongImperative(song);
        }}
      />
    </>
  );
}
