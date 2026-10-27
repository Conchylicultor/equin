import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { FoldMotion } from "@plugins/primitives/plugins/collapsible/web";
import { currentRoutePath } from "@plugins/primitives/plugins/pane/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Button,
  Input,
  Textarea,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  EndpointError,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { useSendSiteMessage } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/web";
import { WebsiteArrow } from "@plugins/apps/plugins/website/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  EMPTY_DRAFT,
  canSend,
  messageBody,
  phaseAfter,
  waitText,
  type ContactDraft,
  type ContactPhase,
} from "../internal/draft";

const checkIcon = symbol("check");

const COMPOSING: ContactPhase = { kind: "compose", notice: null };

/**
 * Scroll just enough to show the form's action (and, through its scroll
 * margin, the card's bottom edge under it): the card ends the page, so a
 * grown card would otherwise hide Send below the fold — on open, and when a
 * notice pushes it down.
 */
function revealAction(el: HTMLElement | null): void {
  revealElement(el, { block: "nearest", behavior: "smooth" });
}

/**
 * "Get in touch", and the message form it grows into — in place, inside the
 * card. The button folds away as the form folds in (two `FoldMotion`s, so only
 * the card's bottom edge moves), and once the form has settled the page
 * scrolls just enough to bring Send into view.
 *
 * The draft survives Cancel / Esc; a message is never lost silently — a
 * refusal or a failed request is said inline with the text kept.
 */
export function ContactReach() {
  const sendSiteMessage = useSendSiteMessage();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ContactDraft>(EMPTY_DRAFT);
  const [phase, setPhase] = useState<ContactPhase>(COMPOSING);
  // Who the last thank-you named — kept past "Send another", so the note
  // still reads right while it folds away.
  const [sentTo, setSentTo] = useState("");
  /** When the form (or "Send another") opened — the server's pace check reads it. */
  const openedAt = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  /** Close happened from inside the form: focus goes back to the trigger. */
  const returnFocus = useRef(false);

  useEffect(() => {
    if (open) {
      messageRef.current?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  const revealSend = () => revealAction(sendRef.current);

  const notice = phase.kind === "compose" ? phase.notice : null;
  useEffect(() => {
    if (notice !== null) revealAction(sendRef.current);
  }, [notice]);

  const openForm = () => {
    openedAt.current = performance.now();
    setPhase(COMPOSING);
    setOpen(true);
  };

  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };

  const sendAnother = () => {
    openedAt.current = performance.now();
    setPhase(COMPOSING);
    messageRef.current?.focus({ preventScroll: true });
  };

  // Returned to `Button`, which pends while it runs.
  const send = async () => {
    const body = messageBody(
      draft,
      performance.now() - openedAt.current,
      // `location.host`: the gateway rewrites the Host header the server sees.
      { host: window.location.host, page: currentRoutePath() },
    );
    try {
      const response = await sendSiteMessage(body);
      setPhase(phaseAfter(response, body.replyTo));
      if (response.kind === "sent") {
        setSentTo(body.replyTo);
        setDraft(EMPTY_DRAFT);
      }
    } catch (err) {
      // No answer (offline) or a refusal: said inline, the text kept.
      if (!(err instanceof EndpointError || err instanceof TypeError))
        throw err;
      setPhase({
        kind: "compose",
        notice: {
          kind: "error",
          message:
            err instanceof TypeError
              ? "The message could not be sent — check your connection and try again."
              : `The message could not be sent (${getEndpointErrorMessage(err)}). Try again, or write to the address above.`,
        },
      });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // Through the button, so ⌘↵ pends it exactly like a click (and does
      // nothing while it is disabled).
      sendRef.current?.click();
    }
  };

  const ready = canSend(draft);

  return (
    <div className="w-full">
      <FoldMotion open={!open}>
        <Button
          ref={triggerRef}
          variant="secondary"
          className="font-semibold"
          aria-expanded={open}
          aria-controls={formId}
          onClick={openForm}
        >
          Get in touch
          <WebsiteArrow />
        </Button>
      </FoldMotion>
      <FoldMotion
        open={open}
        id={formId}
        role="group"
        aria-label="Get in touch"
        onOpened={revealSend}
      >
        {/* Not a native submit: Send and ⌘↵ both go through the Button's
            click, so both pend it. */}
        <form
          onSubmit={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          noValidate
        >
          <FoldMotion open={phase.kind === "compose"}>
            <Stack gap="sm">
              <Textarea
                ref={messageRef}
                name="message"
                aria-label="Message"
                placeholder="What would you like to talk about?"
                rows={5}
                value={draft.message}
                onChange={(e) =>
                  setDraft({ ...draft, message: e.target.value })
                }
              />
              <Input
                type="email"
                name="email"
                aria-label="Your email"
                autoComplete="email"
                placeholder="Your email, so we can reply"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
              {/* The honeypot: invisible, unreachable by keyboard, hidden from
                  assistive tech. Only a bot filling every input finds it. */}
              <div aria-hidden className="sr-only">
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={draft.honeypot}
                  onChange={(e) =>
                    setDraft({ ...draft, honeypot: e.target.value })
                  }
                />
              </div>
              {notice && (
                <Text
                  as="p"
                  variant="caption"
                  tone={notice.kind === "error" ? "destructive" : "muted"}
                  role="alert"
                >
                  {notice.kind === "rate-limited"
                    ? `You've sent several messages in a short while. Please try again in ${waitText(notice.retryAfterS)}.`
                    : notice.message}
                </Text>
              )}
              <Stack direction="row" gap="lg" align="center" justify="end">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={close}
                >
                  Cancel
                </Button>
                <Button
                  ref={sendRef}
                  type="button"
                  variant="secondary"
                  // Revealing Send also brings the card's bottom padding up.
                  className="scroll-mb-12 font-semibold"
                  disabled={!ready}
                  onClick={send}
                >
                  Send
                  <WebsiteArrow />
                </Button>
              </Stack>
            </Stack>
          </FoldMotion>
          <FoldMotion open={phase.kind === "sent"}>
            <SentNote replyTo={sentTo} onAnother={sendAnother} />
          </FoldMotion>
        </form>
      </FoldMotion>
    </div>
  );
}

function SentNote({
  replyTo,
  onAnother,
}: {
  replyTo: string;
  onAnother: () => void;
}) {
  return (
    <Stack direction="row" gap="md" align="start" role="status">
      <Center
        as="span"
        className={cn(
          rigidClass(),
          "size-7 rounded-full bg-success/15 text-success",
        )}
      >
        <Icon icon={checkIcon} />
      </Center>
      <Stack gap="2xs" align="start">
        <Text as="p" variant="body" className="font-semibold">
          Message sent
        </Text>
        <Text as="p" variant="body" tone="muted">
          Thanks — a copy is on its way to {replyTo}, and we'll reply there.
        </Text>
        <Button
          type="button"
          variant="link"
          aspect="inline"
          className="text-muted-foreground underline decoration-foreground/25 underline-offset-[3px] hover:text-foreground hover:decoration-current"
          onClick={onAnother}
        >
          Send another
        </Button>
      </Stack>
    </Stack>
  );
}
