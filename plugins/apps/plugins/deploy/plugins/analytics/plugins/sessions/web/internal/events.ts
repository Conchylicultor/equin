import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

export interface EventPresentation {
  icon: IconRef;
  /** What the visitor did, in words. */
  label: string;
}

/**
 * How the timeline names the events the equin website sends (its `track(…)`
 * calls). Keyed by name; an event not listed still renders — by its own name,
 * with the generic icon — so a new event shows up before anyone describes it.
 */
const KNOWN: Readonly<Record<string, EventPresentation>> = {
  improve_open: { icon: symbol("auto-awesome"), label: "Opened Improve" },
  improve_element_picked: {
    icon: symbol("ads-click"),
    label: "Picked an element",
  },
  improve_show_me: { icon: symbol("play-arrow"), label: "Clicked “Show me”" },
  foundations_card_open: {
    icon: symbol("web-asset"),
    label: "Opened a foundations card",
  },
  foundations_expand_all: {
    icon: symbol("unfold-more"),
    label: "Expanded every foundations card",
  },
  download_open_claude_code: {
    icon: symbol("terminal"),
    label: "Opened Claude Code",
  },
  download_try_demo: {
    icon: symbol("play-arrow"),
    label: "Opened the demo from Download",
  },
  download_open_claude_app: {
    icon: symbol("install-desktop"),
    label: "Opened the Claude app",
  },
};

const COPY = symbol("content-copy");
const GENERIC = symbol("bolt");

export function presentEvent(name: string): EventPresentation {
  const known = KNOWN[name];
  if (known) return known;
  // `download_copy_<kind>` — one per install command.
  if (name.startsWith("download_copy_"))
    return {
      icon: COPY,
      label: `Copied the ${name.slice("download_copy_".length).replaceAll("_", " ")} command`,
    };
  return { icon: GENERIC, label: name };
}

/** An event's props as `key=value` pairs, the way the timeline prints them. */
export function propsText(
  props: Readonly<Record<string, string>> | null,
): string {
  if (!props) return "";
  return Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
}
