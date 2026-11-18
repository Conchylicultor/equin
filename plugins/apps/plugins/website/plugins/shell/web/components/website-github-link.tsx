import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  ActionFormShield,
  useActionForm,
} from "@plugins/primitives/plugins/action-presentation/web";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";
import { brand } from "@plugins/ui/plugins/icons/core";
import { WEBSITE_NAV_LADDER, WebsiteMenuRow } from "./website-nav-link";

const githubIcon = brand("github");

/**
 * The GitHub mark in the shared site header, between the pages and the Wish
 * pill: equin is open source, and the code is the one destination that is not a
 * page of this site.
 *
 * An icon rather than a word, so it reads as "leaves the site" rather than as a
 * third page competing with Apps and Story. Quiet like the page links — the
 * secondary grey, up to full foreground on hover, no hover box — at 20px, the
 * height of the words beside it, and spaced like them (`website-nav-icon`).
 *
 * In the header's navigation cohort ({@link WEBSITE_NAV_LADDER}): on a phone
 * it is the ☰ menu's last row. The icon button is shielded, so its own `row`
 * rung (an icon row) never stands in for this one.
 */
export function WebsiteGithubLink() {
  const form = useActionForm(WEBSITE_NAV_LADDER);
  const link = (
    <a href={SOURCE_REPO_URL} target="_blank" rel="noreferrer noopener" />
  );
  if (form === "row") {
    return (
      <WebsiteMenuRow
        label="GitHub"
        tone="muted"
        href={SOURCE_REPO_URL}
        target="_blank"
        rel="noreferrer noopener"
      />
    );
  }
  return (
    <div className="website-nav-icon">
      <ActionFormShield>
        <IconButton
          icon={githubIcon}
          label="equin on GitHub"
          className="text-muted-foreground hover:text-foreground hover:bg-transparent"
          render={link}
        />
      </ActionFormShield>
    </div>
  );
}
