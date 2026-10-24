import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { useCloseHelpMenu } from "@plugins/hints/plugins/help-menu/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { openAsk, useAskState } from "../internal/ask-store";
import { useRunQuestion } from "../internal/use-question";

const askIcon = symbol("forum");

/**
 * The ? menu's Ask equin entry: opens the card. With a run minimized (or the
 * card closed on one), it reads "Back to your question", the question under
 * it once known.
 */
export function AskEquinEntry() {
  const close = useCloseHelpMenu();
  const { mode, conversationId } = useAskState();
  const back = conversationId !== null && mode !== "open";
  const question = useRunQuestion(back ? conversationId : null);
  const select = () => {
    close();
    openAsk();
  };
  const icon = <Icon icon={askIcon} />;
  if (!back) {
    return (
      <ControlPanel.Row icon={icon} onSelect={select}>
        Ask equin how to…
      </ControlPanel.Row>
    );
  }
  return question === null ? (
    <ControlPanel.Row icon={icon} onSelect={select}>
      Back to your question
    </ControlPanel.Row>
  ) : (
    <ControlPanel.Row icon={icon} description={question} onSelect={select}>
      Back to your question
    </ControlPanel.Row>
  );
}
