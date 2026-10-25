import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Hero } from "./hero";
import { Pins } from "./pins";
import { RecentsSection } from "./recents-section";
import "./start-page.css";

/**
 * The browser start page: the empty-state landing shown in the viewport when no
 * URL is loaded. A centered, max-width column: the hero (greeting + search),
 * the pins (curated quick links, then the live bookmarks), and the recently
 * visited pages. The webview already provides the scroll container, so this
 * only lays out content — it never owns a second scroll region.
 */
export function StartPage() {
  return (
    <Inset x="xl" className="browser-start mx-auto w-full">
      <Stack gap="2xl" className="browser-start-stack">
        <Hero />
        <Pins />
        <RecentsSection />
      </Stack>
    </Inset>
  );
}
