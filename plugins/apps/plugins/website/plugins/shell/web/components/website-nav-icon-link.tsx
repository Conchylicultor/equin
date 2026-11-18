import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  ActionFormShield,
  useActionForm,
} from "@plugins/primitives/plugins/action-presentation/web";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";
import { brand, type IconRef } from "@plugins/ui/plugins/icons/core";
import { DISCORD_URL } from "../../core";
import { WEBSITE_NAV_LADDER, WebsiteMenuRow } from "./website-nav-link";

const githubIcon = brand("github");
const discordIcon = brand("discord");

/**
 * An off-site destination in the shared site header — the source on GitHub, the
 * community on Discord — between the pages and the actions.
 *
 * An icon rather than a word, so it reads as "leaves the site" rather than as
 * one more page competing with Vision and Apps. Quiet like the page links — the
 * secondary grey, up to full foreground on hover, no hover box — at 20px, the
 * height of the words beside it, and spaced like them (`website-nav-icon`).
 *
 * In the header's navigation cohort ({@link WEBSITE_NAV_LADDER}): on a phone
 * it is a row of the ☰ menu, named. The icon button is shielded, so its own
 * `row` rung (an icon row) never stands in for this one.
 */
function WebsiteNavIconLink({
  href,
  icon,
  name,
  label,
}: {
  href: string;
  icon: IconRef;
  /** The destination's name, as the ☰ menu's row reads it. */
  name: string;
  /** What the icon says to assistive tech and in its tooltip. */
  label: string;
}) {
  const form = useActionForm(WEBSITE_NAV_LADDER);
  if (form === "row") {
    return (
      <WebsiteMenuRow
        label={name}
        tone="muted"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
      />
    );
  }
  return (
    <div className="website-nav-icon">
      <ActionFormShield>
        <IconButton
          icon={icon}
          label={label}
          className="text-muted-foreground hover:text-foreground hover:bg-transparent"
          render={<a href={href} target="_blank" rel="noreferrer noopener" />}
        />
      </ActionFormShield>
    </div>
  );
}

/** The source: equin is open source, and the code is on GitHub. */
export function WebsiteGithubLink() {
  return (
    <WebsiteNavIconLink
      href={SOURCE_REPO_URL}
      icon={githubIcon}
      name="GitHub"
      label="equin on GitHub"
    />
  );
}

/** The community: equin's Discord server. */
export function WebsiteDiscordLink() {
  return (
    <WebsiteNavIconLink
      href={DISCORD_URL}
      icon={discordIcon}
      name="Discord"
      label="equin on Discord"
    />
  );
}
