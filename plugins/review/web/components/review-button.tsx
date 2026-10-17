import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { convReviewPane } from "../panes";
import { Review } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const differenceIcon = symbol("difference");

export function ReviewButton() {
  const { convId } = conversationPane.useParams();
  const { isOpen, toggle } = convReviewPane.useToggle({});
  const sections = Review.Section.useContributions();

  return (
    <Button
      variant={isOpen ? "secondary" : "ghost"}
      tooltip="Review"
      aria-label="Review"
      aria-pressed={isOpen}
      onClick={toggle}
      className="gap-xs"
    >
      <Icon icon={differenceIcon} />
      {sections.map((s) => {
        const S = s.summary;
        return S ? (
          <S key={s.id} conversationId={convId} source={{ kind: "working" }} />
        ) : null;
      })}
    </Button>
  );
}
