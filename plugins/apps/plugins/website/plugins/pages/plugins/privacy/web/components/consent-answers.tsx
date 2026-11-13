import {
  setAnalyticsConsent,
  track,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import "./privacy.css";

/**
 * The two answers to the consent prompt, Reject and Accept: the same size and
 * the same shape, side by side, so refusing is exactly as easy as accepting.
 *
 * Two looks, as the prototype (`proto-1794535780-z2i0h7`) draws them:
 * - `prompt` — on the floating card: small, each word followed by a caret
 *   that steps on hover; Reject on a faint fill, Accept on the site's filled
 *   control (the foreground inverted).
 * - `page` — on the privacy page's choice: two equal outlined buttons, the
 *   answer already given (`answered`) filled and pressed; pressing it again
 *   does nothing.
 *
 * Plain buttons dressed by `privacy.css`, not ui-kit `Button`s: their sizes
 * are the prototype's, which the control-size ramp does not have.
 */
export function ConsentAnswers({
  look,
  answered,
}: {
  look: "prompt" | "page";
  answered?: "accepted" | "rejected";
}) {
  return (
    <div className={`consent-answers consent-answers-${look}`}>
      <Answer accepted={false} pressed={answered === "rejected"}>
        Reject
      </Answer>
      <Answer accepted pressed={answered === "accepted"}>
        Accept
      </Answer>
    </div>
  );
}

function Answer({
  accepted,
  pressed,
  children,
}: {
  accepted: boolean;
  pressed: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      data-answer={accepted ? "accept" : "reject"}
      aria-pressed={pressed}
      onClick={() => {
        if (pressed) return;
        setAnalyticsConsent(accepted);
        track("consent_answer", { answer: accepted ? "accept" : "reject" });
      }}
    >
      {children}
    </button>
  );
}
