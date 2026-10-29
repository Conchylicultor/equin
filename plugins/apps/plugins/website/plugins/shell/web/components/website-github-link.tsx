import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";
import { brand } from "@plugins/ui/plugins/icons/core";

const githubIcon = brand("github");

/**
 * The GitHub mark in the shared site header, between the pages and the Improve
 * pill: equin is open source, and the code is the one destination that is not a
 * page of this site.
 *
 * An icon rather than a word, so it reads as "leaves the site" rather than as a
 * third page competing with Apps and Story. Quiet like the page links — the
 * secondary grey, up to full foreground on hover, no hover box.
 */
export function WebsiteGithubLink() {
  return (
    <IconButton
      icon={githubIcon}
      label="equin on GitHub"
      className="text-muted-foreground hover:text-foreground hover:bg-transparent"
      render={
        <a href={SOURCE_REPO_URL} target="_blank" rel="noreferrer noopener" />
      }
    />
  );
}
