import { createContext, useContext, useMemo, type ComponentProps } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ActionFormShield,
  useActionForm,
} from "@plugins/primitives/plugins/action-presentation/web";
import {
  HoverPopover,
  type HoverPopoverApi,
} from "@plugins/primitives/plugins/overlay/plugins/hover-popover/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Website } from "../slots";
import { WEBSITE_NAV_LADDER, WebsiteMenuRow } from "./website-nav-link";

const chevronIcon = symbol("keyboard-arrow-down");

/**
 * Where a `WebsiteLearnLink` is drawn: an entry of the header's hover panel
 * (with the panel's `close`, so a pick closes it), or a row of the ☰ menu.
 */
type LearnPlace = { kind: "panel"; api: HoverPopoverApi } | { kind: "row" };

const LearnPlaceContext = createContext<LearnPlace | null>(null);

const ROW_PLACE: LearnPlace = { kind: "row" };

/**
 * "Learn ▾" in the shared site header: the pages that explain equin rather
 * than show it (`Website.LearnEntry` — Foundations, Story) folded behind one
 * word, so the header lists the site's two places (Vision, Apps) and its
 * actions without four page links competing.
 *
 * It opens on hover (or ArrowDown, or a first tap): the word itself is no
 * destination, so there is nothing for its click to do. On a phone it is in the
 * header's navigation cohort ({@link WEBSITE_NAV_LADDER}) and its entries
 * become rows of the ☰ menu — the menu's own entries, never a menu in a menu.
 */
export function WebsiteLearnMenu() {
  const form = useActionForm(WEBSITE_NAV_LADDER);
  if (form === "row") {
    return (
      <LearnPlaceContext.Provider value={ROW_PLACE}>
        <ActionFormShield>
          <Website.LearnEntry.Render />
        </ActionFormShield>
      </LearnPlaceContext.Provider>
    );
  }
  return (
    <HoverPopover
      label="Learn"
      align="center"
      padding="xs"
      trigger={
        <Button
          variant="ghost"
          className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground hover:bg-transparent aria-expanded:bg-transparent"
        >
          Learn
          <Icon icon={chevronIcon} className="size-4" />
        </Button>
      }
      content={(api) => <LearnPanel api={api} />}
    />
  );
}

/** The hover panel's entries, each closing the panel once it opens its page. */
function LearnPanel({ api }: { api: HoverPopoverApi }) {
  const place = useMemo<LearnPlace>(() => ({ kind: "panel", api }), [api]);
  return (
    <LearnPlaceContext.Provider value={place}>
      <ActionFormShield>
        <Stack gap="none" className="w-72">
          <Website.LearnEntry.Render />
        </Stack>
      </ActionFormShield>
    </LearnPlaceContext.Provider>
  );
}

/**
 * One page of the Learn menu: its name, and a line saying what it is. A page
 * plugin renders one from its `Website.LearnEntry` contribution, spreading the
 * link it opens (`openPane.link(…)`) onto it.
 */
export function WebsiteLearnLink({
  label,
  gloss,
  onClick,
  ...link
}: {
  label: string;
  /** What the page is, in one line under its name. */
  gloss: string;
} & Omit<ComponentProps<"button">, "children" | "className" | "type">) {
  const place = useContext(LearnPlaceContext);
  if (!place)
    throw new Error(
      "WebsiteLearnLink renders only inside the header's Learn menu (a Website.LearnEntry contribution).",
    );
  if (place.kind === "row")
    return <WebsiteMenuRow label={label} onClick={onClick} {...link} />;
  return (
    <button
      type="button"
      {...link}
      className="website-learn-entry"
      onClick={(e) => {
        onClick?.(e);
        place.api.close();
      }}
    >
      <Text as="div" variant="label" tone="strong">
        {label}
      </Text>
      <Text as="div" variant="caption" tone="muted">
        {gloss}
      </Text>
    </button>
  );
}
