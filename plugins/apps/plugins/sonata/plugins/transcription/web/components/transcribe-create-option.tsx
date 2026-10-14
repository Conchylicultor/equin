import type { CreateOption } from "@plugins/primitives/plugins/data-view/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { TranscribeDialog } from "./transcribe-dialog";

const transcribeIcon = symbol("document-scanner");

/**
 * The library "+" menu's Transcribe entry: a link or files are needed up
 * front, so `onSelect` opens the dialog, which creates the song, launches the
 * agent and opens it. Awaiting the dialog keeps the menu's pending state for
 * its lifetime.
 */
export const transcribeCreateOption: CreateOption = {
  id: "transcription",
  label: "Transcribe…",
  description: "Turn sheet music in a video, photos or a PDF into a song.",
  icon: <Icon icon={transcribeIcon} className="size-4" />,
  onSelect: () =>
    openDialog((close) => <TranscribeDialog onClose={close} />, {
      size: "md",
      dismissible: false,
    }),
};
