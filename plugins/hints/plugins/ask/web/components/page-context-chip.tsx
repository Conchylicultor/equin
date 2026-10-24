import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { parsePageContext } from "../../core";

const pageIcon = symbol("location-on");

/**
 * The `<page-context>` token as the user sees it in their message: the page
 * the reply was sent from ("Pages · Roadmap"), its route in the tooltip — the
 * outline stays the agent's. Not a control: it says what went with the words.
 */
export function PageContextChip({
  content,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  const page = parsePageContext(content);
  if (page === null) return <>{content}</>;
  const label = [page.appName ?? page.app, page.title]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Badge
      contentEditable={false}
      className="max-w-56"
      icon={
        <Icon
          icon={pageIcon}
          className={cn("text-muted-foreground", rigidClass())}
        />
      }
      tooltip={`Sent from ${page.path}`}
    >
      {label === "" ? page.path : label}
    </Badge>
  );
}
