import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { openInBrowserTab } from "@plugins/primitives/plugins/link-gesture/web";
import { NewTabGlyph } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { LaunchAgentForm } from "@plugins/primitives/plugins/launch/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { synthesiseTitleFallback } from "@plugins/tasks/plugins/task-title/core";
import {
  startTour,
  useHints,
  useResetHints,
  useTours,
} from "@plugins/hints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { HELP_CATEGORY_ID } from "../../core";
import { useCloseHelpMenu } from "../internal/close-menu";

const replayIcon = symbol("replay");
const lightbulbIcon = symbol("lightbulb");
const guideIcon = symbol("menu-book");
const askIcon = symbol("forum");

const GUIDE_URL = "https://equin.ai/website/guide";

/**
 * Starts the primary tour (`defineTour({ primary: true })`) — the engine
 * navigates to its app first. Absent when no plugin declares one.
 */
export function ReplayTourEntry() {
  const close = useCloseHelpMenu();
  const primary = useTours().find((t) => t.primary);
  if (!primary) return null;
  return (
    <ControlPanel.Row
      icon={<Icon icon={replayIcon} />}
      onSelect={() => {
        close();
        startTour(primary.id);
      }}
    >
      Replay the tour
    </ControlPanel.Row>
  );
}

/** Forgets every declared tip's seen row, so each shows again at its moment. */
export function ShowTipsAgainEntry() {
  const close = useCloseHelpMenu();
  const hints = useHints();
  const resetHints = useResetHints();
  return (
    <ControlPanel.Row
      icon={<Icon icon={lightbulbIcon} />}
      disabled={hints.length === 0}
      onSelect={() => {
        close();
        // A failed reset rejects unhandled, which the reports plugin files;
        // the toast only follows a reset that landed.
        void resetHints(hints.map((h) => h.id)).then(() =>
          showToast({
            title: "Tips are back on",
            description: "They'll show again as you go.",
          }),
        );
      }}
    >
      Show tips again
    </ControlPanel.Row>
  );
}

/** Opens the equin guide on the website, in a new browser tab. */
export function ReadGuideEntry() {
  const close = useCloseHelpMenu();
  return (
    <ControlPanel.Row
      icon={<Icon icon={guideIcon} />}
      trailing={<NewTabGlyph />}
      onSelect={() => {
        openInBrowserTab(GUIDE_URL);
        close();
      }}
    >
      Read the guide
    </ControlPanel.Row>
  );
}

/**
 * The brief an "Ask equin how to…" agent starts from: answer the user's
 * how-to question about equin — researching the code is fine, changing it is
 * not, unless they ask.
 */
function askHowToPrompt(question: string): string {
  return [
    "The user is asking how to do something in equin (this app — Singularity).",
    "Answer their question: explain where to find it and the steps, in plain",
    "words a user can follow in the UI. You may read the codebase and docs to",
    "find the answer, but do NOT change code, build or push unless they ask you",
    "to. If equin cannot do it yet, say so plainly and offer to file a task for it.",
    "",
    `Their question:\n${question.trim()}`,
  ].join("\n");
}

/** Opens the launch form for a how-to question, filed under Help. */
function openAskDialog(): void {
  void openDialog(
    (closeDialog) => (
      <LaunchAgentForm
        draftKey="help-menu.ask"
        title="Ask equin how to…"
        description="Ask how to do something. An agent looks into it and its answer comes back to your queue."
        placeholder={
          'Ask how to do something…  e.g. "How do I compare two prototypes?"'
        }
        textRequired
        getRequest={(userText) => ({
          prompt: askHowToPrompt(userText),
          categoryId: HELP_CATEGORY_ID,
          // The task is the question, in the user's words — not the form's
          // heading, which every Help task would otherwise share.
          title: synthesiseTitleFallback(userText.trim()),
        })}
        // No toast of our own: a started launch is announced by the bell's
        // "Conversation started" (titled with the question), and a second
        // toast would say the same thing twice.
        onSubmitted={() => closeDialog()}
      />
    ),
    { size: "lg" },
  );
}

/** Asks an agent a how-to question; the answer lands in the queue. */
export function AskEquinEntry() {
  const close = useCloseHelpMenu();
  return (
    <ControlPanel.Row
      icon={<Icon icon={askIcon} />}
      onSelect={() => {
        close();
        openAskDialog();
      }}
    >
      Ask equin how to…
    </ControlPanel.Row>
  );
}
