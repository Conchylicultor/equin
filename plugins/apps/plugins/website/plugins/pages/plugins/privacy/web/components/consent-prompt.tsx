import { useAnalyticsConsent } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useOpenPane, usePathname } from "@plugins/primitives/plugins/pane/web";
import { privacyPage } from "../../core";
import { privacyPane } from "../panes";
import { ConsentAnswers } from "./consent-answers";
import "./privacy.css";

/**
 * The consent prompt (`Website.Layer`): one plain sentence and the two
 * answers, on a small floating card 24px from the surface's bottom-right
 * corner — 12px from its sides and bottom on a phone, where it takes the
 * screen's width. It rises in a moment after the page. Shown while this
 * browser has not answered; an answer, here or on the privacy page, puts it
 * away in every open tab.
 *
 * Not on the privacy page itself, which asks the same question in place. Not
 * in a render without browser storage (the crawlable snapshot): there the
 * answer is unknown, and a robot is not asked.
 *
 * Drawn to the prototype (`proto-1794535780-z2i0h7`, `consent: card`) by
 * `privacy.css`, every colour a theme token.
 */
export function ConsentPrompt() {
  const consent = useAnalyticsConsent();
  const path = usePathname();
  const openPane = useOpenPane();
  if (consent !== "undecided" || path === privacyPage.path) return null;
  return (
    <aside className="consent-prompt" aria-label="Cookie consent">
      <p>
        We use cookies to improve our services. Read our{" "}
        {/* A link button, not an `<a>`: an in-app link is click handlers
            (`openPane.link`), and an `<a>` without an href reads as text —
            the I-beam over it. */}
        <Button
          variant="link"
          aspect="inline"
          className="consent-link"
          {...openPane.link(privacyPane, {}, { mode: "root" })}
        >
          Privacy Policy
        </Button>
        .
      </p>
      <ConsentAnswers look="prompt" />
    </aside>
  );
}
