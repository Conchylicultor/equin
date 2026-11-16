import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { TooltipDoc } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";
import { buildIssueUrl } from "@plugins/integrations/plugins/github-issues/core";
import { brand } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import type { WishFooterActionProps } from "@plugins/wish/web";

const githubIcon = brand("github");

/** The repository label every wish filed from the app carries (applied for a filer with triage rights). */
const WISH_LABEL = "Wish";

/**
 * Sends the drafted wish to GitHub instead of an agent here: a real
 * `<a target="_blank">` to the repository's new-issue form, prefilled with the
 * wish (picks made readable, titled from its first line) and the page it is
 * about. The browser opens the tab on the user's click; the click also clears
 * the draft and closes the popover, as Launch does once it has filed.
 */
export function FileOnGithubButton({
  draft,
  pageUrl,
  discard,
}: WishFooterActionProps) {
  const tooltip = (
    <TooltipDoc title="File on GitHub">
      Open a GitHub issue with this wish instead of launching an agent.
    </TooltipDoc>
  );
  if (draft.trim() === "") {
    return (
      <Button variant="ghost" disabled tooltip={tooltip} className="gap-none">
        <GithubFace />
      </Button>
    );
  }
  const href = buildIssueUrl({
    repoUrl: SOURCE_REPO_URL,
    text: draft,
    ...(pageUrl === null ? {} : { pageUrl }),
    notes: ["Filed from the Wish button in the equin app"],
    labels: [WISH_LABEL],
  });
  return (
    <Button
      variant="ghost"
      tooltip={tooltip}
      className="gap-none"
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
      onClick={discard}
    >
      <GithubFace />
    </Button>
  );
}

/**
 * The GitHub mark, its "File on GitHub" label folded away beside it until the
 * button is hovered or keyboard-focused — so the footer's one primary action
 * stays Launch. The label animates to its own width (a `0fr → 1fr` grid
 * track, clipped while folded); the icon-to-label gap rides inside the label, so the folded button
 * is the icon alone.
 */
function GithubFace() {
  return (
    <>
      <Icon icon={githubIcon} />
      <span
        // eslint-disable-next-line layout/no-adhoc-layout -- the fold is a one-column grid whose track animates 0fr → 1fr, so the label opens to its own width with none restated here; no layout primitive owns an animatable track
        className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-hover/button:grid-cols-[1fr] group-focus-visible/button:grid-cols-[1fr] motion-reduce:transition-none"
      >
        <Clip className={yieldClass("x")}>
          <span className="pl-xs">File on GitHub</span>
        </Clip>
      </span>
    </>
  );
}
