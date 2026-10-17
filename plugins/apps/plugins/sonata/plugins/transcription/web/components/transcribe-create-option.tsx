import type { CreateOption } from "@plugins/primitives/plugins/data-view/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { TranscribeDialog } from "./transcribe-dialog";

const transcribeIcon = symbol("document-scanner");

/**
 * The library "+" menu's Transcribe entry: the request is needed up front, so
 * `onSelect` opens the launch dialog, which creates the song, launches the
 * agent and opens it. Awaiting the dialog keeps the menu's pending state for
 * its lifetime. Dismissible: the form keeps its draft, so a stray click loses
 * nothing.
 */
export const transcribeCreateOption: CreateOption = {
  id: "transcription",
  label: "Transcribe…",
  description:
    "An agent turns sheet music in a video, photos or a PDF into a song.",
  icon: <Icon icon={transcribeIcon} className="size-4" />,
  onSelect: () =>
    openDialog((close) => <TranscribeDialog onClose={close} />, {
      size: "lg",
    }),
};
