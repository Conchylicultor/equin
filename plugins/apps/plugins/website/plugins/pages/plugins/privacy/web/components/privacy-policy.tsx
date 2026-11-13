import { useAnalyticsConsent } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import {
  CONTACT_EMAIL,
  CONTACT_MAILTO,
} from "@plugins/apps/plugins/website/plugins/shell/core";
import { WebsiteBand } from "@plugins/apps/plugins/website/plugins/shell/web";
import { ConsentAnswers } from "./consent-answers";
import "./privacy.css";

/**
 * The privacy policy: this browser's choice first (where the prompt's answer
 * is changed), then what a visit records, the two ways a return visit is
 * recognised — with the key the visitor allowed, or by the daily hash without
 * one — how long it is kept, and where to ask.
 *
 * Every fact here is the analytics plugin's (`apps/deploy/analytics/collect`:
 * its recorded fields, `RAW_RETENTION_DAYS`, `IDENTITY_WINDOW_DAYS`,
 * `CONSENT_KEY_DAYS`); a change there is a change to this page.
 */
export function PrivacyPolicy() {
  return (
    <WebsiteBand section="policy" rhythm="page-body">
      <article className="privacy-policy">
        <h2>Your choice for this browser</h2>
        <Choice />

        <h2>What a visit records</h2>
        <dl className="privacy-records">
          <dt>Pages</dt>
          <dd>
            Which pages you open, how long each stays on screen, and how far
            down you read.
          </dd>
          <dt>Where from</dt>
          <dd>
            The site that linked here (its domain, never the full address) and
            campaign tags in the link.
          </dd>
          <dt>Country</dt>
          <dd>
            Worked out from your IP address when the visit arrives. The address
            itself is never stored.
          </dd>
          <dt>Device</dt>
          <dd>
            Phone, tablet or computer; the browser and system family, without
            versions; your language.
          </dd>
          <dt>Timing</dt>
          <dd>How long the page took to load.</dd>
        </dl>

        <h2>Telling a return visit from a new one</h2>
        <div className="privacy-ways">
          <section className="privacy-way">
            <span className="privacy-way-kicker">If you accept</span>
            <h3>A random id in this browser</h3>
            <p>
              A meaningless number, kept in this browser&rsquo;s storage for 13
              months and read only by equin.ai.
            </p>
            <p>
              It works on any network, so coming back from your phone on 4G
              still counts as coming back.
            </p>
          </section>
          <section className="privacy-way">
            <span className="privacy-way-kicker">If you reject</span>
            <h3>Nothing in your browser</h3>
            <p>
              Your network&rsquo;s address and browser name are mixed with a
              secret that changes every day and turned into a code that cannot
              be reversed.
            </p>
            <p>
              Each day&rsquo;s secret is deleted after 30 days. A new network
              makes you look like a new visitor.
            </p>
          </section>
        </div>

        <h2>How long it is kept</h2>
        <p>
          Each visit is kept <strong>90 days</strong>, then only folded into
          daily totals: visitors, pages and sources per day, with no visit
          behind them.
        </p>
        <p>
          Rejecting removes the id from this browser straight away. After 13
          months, you are asked again.
        </p>

        <h2>Questions</h2>
        <p>
          Write to{" "}
          <a className="consent-link" href={CONTACT_MAILTO}>
            {CONTACT_EMAIL}
          </a>
          . You can ask what is recorded about a visit, or for it to be deleted.
        </p>
      </article>
    </WebsiteBand>
  );
}

const STATE = {
  undecided: {
    label: "Not decided",
    detail: "Until you choose, nothing is stored in your browser.",
  },
  accepted: {
    label: "Remembered",
    detail: "A random id is kept in this browser for 13 months.",
  },
  rejected: {
    label: "Not remembered",
    detail: "Nothing is stored in your browser but this answer.",
  },
} as const;

/**
 * Where this browser stands, and the two answers to change it. Without
 * browser storage (the crawlable snapshot) the answer is unknown: the answers
 * are offered with no state beside them.
 */
function Choice() {
  const consent = useAnalyticsConsent();
  const state = consent === "unknown" ? null : STATE[consent];
  return (
    <div className="privacy-choice" data-consent={consent}>
      <div className="privacy-choice-state">
        {state && (
          <>
            <b>{state.label}</b>
            <span>{state.detail}</span>
          </>
        )}
      </div>
      <ConsentAnswers
        look="page"
        answered={
          consent === "accepted" || consent === "rejected" ? consent : undefined
        }
      />
    </div>
  );
}
