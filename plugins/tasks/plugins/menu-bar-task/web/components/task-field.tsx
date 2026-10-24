import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { submitChain } from "@plugins/tasks/plugins/task-draft-form/web";
import { TaskLaunch } from "@plugins/tasks/plugins/launch-options/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const fileIcon = symbol("bolt");
const filedIcon = symbol("check-circle");
const sendIcon = symbol("arrow-upward");

/** Six lines of text, then the field scrolls. */
const MAX_FIELD_PX = 132;

/** What the field says about the last submit. */
type Outcome =
  | { kind: "idle" }
  | { kind: "filed"; summary: string }
  | { kind: "failed"; message: string };

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * The panel's task field: type, Enter files it as a top-level task
 * (Shift+Enter adds a line, Escape clears). The task goes through the
 * task-draft form's own submit, as one card with every launch option at its
 * default — so auto-start and the rest behave exactly as when filed from
 * Improve. No page URL is attached: the panel is not a page the task is about.
 *
 * The field grows with its text up to six lines. WebKit (the helper's webview)
 * has no `field-sizing`, so the height is set from the text's own scroll height
 * on each change.
 */
export function MenuBarTaskField() {
  const fetchEndpoint = useFetchEndpoint();
  const launchOptions = TaskLaunch.Option.useContributions();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = field.current;
    if (el === null) return;
    // Empty, the field is its one `rows` line: no measurement (the panel may
    // not be laid out yet on mount, when scrollHeight reads 0).
    el.style.height = "";
    if (text === "") return;
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_PX)}px`;
  }, [text]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitChain(fetchEndpoint, {
        cards: [
          {
            localId: "menu-bar",
            text: trimmed,
            options: {},
            includeUrl: false,
            linkedToPrev: false,
          },
        ],
        target: { kind: "root" },
        relate: undefined,
        url: "",
        captureUrlDefault: false,
        options: launchOptions,
      });
      if (result.ok) {
        setOutcome({ kind: "filed", summary: firstLine(trimmed) });
        setText("");
      } else {
        setOutcome({
          kind: "failed",
          message: result.errorMessage ?? "Submit failed",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText("");
      setOutcome({ kind: "idle" });
    }
  };

  const placeholder =
    outcome.kind === "filed"
      ? `Filed — “${outcome.summary}”`
      : "Ask or file a task…";

  return (
    <Stack gap="2xs" className={insetClass({ x: "2xs", b: "xs" })}>
      <Surface
        level="sunken"
        className="rounded-lg focus-within:ring-2 focus-within:ring-ring/50"
      >
        <Stack
          direction="row"
          gap="sm"
          align="start"
          className={insetClass({ y: "xs", r: "xs", l: "sm" })}
        >
          <Icon
            icon={outcome.kind === "filed" ? filedIcon : fileIcon}
            className={cn(
              "size-4 text-muted-foreground",
              rigidClass(),
              outcome.kind === "filed" && "text-success",
            )}
          />
          <textarea
            ref={field}
            rows={1}
            value={text}
            aria-label="Task"
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              if (outcome.kind !== "idle") setOutcome({ kind: "idle" });
            }}
            onKeyDown={onKeyDown}
            className={cn(
              "resize-none bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground",
              fillClasses("x"),
            )}
          />
          {text.trim() !== "" && (
            <ControlSizeProvider size="xs">
              <IconButton
                variant="default"
                icon={sendIcon}
                label="File task"
                shortcut="↵"
                className={rigidClass()}
                onClick={submit}
              />
            </ControlSizeProvider>
          )}
        </Stack>
      </Surface>
      {outcome.kind === "failed" && (
        <Text
          as="div"
          variant="caption"
          tone="destructive"
          className={insetClass({ x: "sm" })}
        >
          {outcome.message}
        </Text>
      )}
    </Stack>
  );
}
