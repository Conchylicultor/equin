import type { ReactNode } from "react";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");
const helpIcon = symbol("help");

export interface HintCardAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface HintCardProps {
  readonly title: ReactNode;
  readonly body: ReactNode;
  /** A tour's progress: one dot per step, `index` current. Absent on a tip. */
  readonly steps?: { readonly count: number; readonly index: number };
  readonly onClose?: () => void;
  /** A quiet line left of the buttons ("Hover it to unfold"). */
  readonly footnote?: ReactNode;
  readonly alt?: HintCardAction;
  readonly onBack?: () => void;
  readonly primary?: HintCardAction;
}

/**
 * The content of the coach card — a tour step or a tip: (step dots and ×),
 * title, body, then a foot of footnote, alt, Back and the primary. It draws
 * no chrome: the stage's card around it does.
 */
export function HintCard({
  title,
  body,
  steps,
  onClose,
  footnote,
  alt,
  onBack,
  primary,
}: HintCardProps) {
  return (
    <ControlSizeProvider size="sm">
      {(steps || onClose) && (
        <div className="hint-card-top">
          {steps && <StepDots {...steps} />}
          {onClose && (
            <button
              type="button"
              className="hint-close"
              aria-label="Skip the tour (Esc)"
              onClick={onClose}
            >
              <Icon icon={closeIcon} />
            </button>
          )}
        </div>
      )}
      <Text as="h2" variant="subheading" tone="strong">
        {title}
      </Text>
      <Text as="div" variant="body" tone="muted" className="hint-card-body">
        {body}
      </Text>
      <div className="hint-card-foot">
        {footnote && (
          <Text as="span" variant="caption" className="hint-footnote">
            {footnote}
          </Text>
        )}
        {alt && (
          <Button variant="ghost" shape="pill" onClick={alt.onClick}>
            {alt.label}
          </Button>
        )}
        <Fill />
        {onBack && (
          <Button variant="ghost" shape="pill" onClick={onBack}>
            Back
          </Button>
        )}
        {primary && (
          <Button shape="pill" onClick={primary.onClick}>
            {primary.label}
          </Button>
        )}
      </div>
    </ControlSizeProvider>
  );
}

function StepDots({ count, index }: { count: number; index: number }) {
  return (
    <div className="hint-steps" aria-label={`Step ${index + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        <i
          key={i}
          data-state={i < index ? "done" : i === index ? "current" : "next"}
        />
      ))}
    </div>
  );
}

export interface WelcomeCardProps {
  readonly icon?: IconRef;
  readonly title: ReactNode;
  readonly body: ReactNode;
  readonly note?: ReactNode;
  readonly start: HintCardAction;
  readonly skip: HintCardAction;
}

/** The welcome card's content: the brand mark, title, body, the two choices and a note. */
export function WelcomeCard({
  icon,
  title,
  body,
  note,
  start,
  skip,
}: WelcomeCardProps) {
  return (
    <ControlSizeProvider size="lg">
      {icon && (
        <div className="hint-mark">
          <Icon icon={icon} active />
        </div>
      )}
      <Text as="h2" variant="title" tone="strong">
        {title}
      </Text>
      <Text as="p" variant="body" tone="muted" className="hint-welcome-body">
        {body}
      </Text>
      <div className="hint-welcome-acts">
        <Button shape="pill" autoFocus onClick={start.onClick}>
          {start.label}
        </Button>
        <Button variant="ghost" shape="pill" onClick={skip.onClick}>
          {skip.label}
        </Button>
      </div>
      {note && (
        <Text
          as="small"
          variant="caption"
          tone="faint"
          className="hint-welcome-note"
        >
          {note}
        </Text>
      )}
    </ControlSizeProvider>
  );
}

/** The farewell toast's content: where the tour lives from now on. */
export function TourFarewell() {
  return (
    <>
      <Icon icon={helpIcon} />
      <div>
        <Text as="div" variant="body" tone="strong">
          The tour is here whenever you want it
        </Text>
        <Text as="small" variant="caption" tone="faint">
          <Icon icon={helpIcon} /> in the toolbar → Replay the tour
        </Text>
      </div>
    </>
  );
}
