import {
  Button,
  ButtonGroup,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";
import {
  useOpenPane,
  type PaneOpenMode,
} from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { type Conversation } from "@plugins/tasks/plugins/tasks-core/core";
import { createConversation } from "@plugins/conversations/core";
import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import {
  choiceIconSize,
  choiceLabel,
  type ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  ModelChoiceLabel,
  useVisibleModels,
  useDefaultModel,
  useSetDefaultModel,
} from "@plugins/conversations/plugins/model-provider/web";
import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import { useClaudeCodeLaunchBlock } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const playArrowIcon = symbol("play-arrow");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");

export type LaunchRequest = {
  prompt?: string;
  taskId?: string;
  attemptId?: string;
  forkFromConversationId?: string;
  /** With `forkFromConversationId`: fork from just before this user message. */
  forkAtMessageUuid?: string;
};

export type LaunchControlProps = {
  getRequest?: () => LaunchRequest | Promise<LaunchRequest>;
  openAfterLaunch?: boolean;
  /**
   * How to open the freshly created conversation pane. Defaults to `"push"`
   * (append to the right of the caller). Surfaces that launch from a root
   * landing pane (e.g. the welcome view) pass `"root"` so the new
   * conversation replaces the chain instead of opening a sibling column.
   */
  openMode?: PaneOpenMode;
  onLaunched?: (conversation: Conversation) => void;
  variant?: "default" | "outline" | "ghost";
  /**
   * Stretch the control to fill its container, with the model dropdown growing
   * to absorb the slack and the launch button kept at its natural width. Use
   * this instead of passing `className="w-full"` — that only widens the group
   * box and leaves both buttons pinned left.
   */
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
} & (
  | { size?: "default"; action?: never }
  | {
      /**
       * The compact form: a [launch | ▾] icon pair — ghost by default, or one
       * outlined split with a seam between its halves (`variant="outline"`).
       */
      size: "icon";
      /**
       * What the launch half says it does, when "launch the default model" is
       * not the whole story (a new conversation beside this one): its glyph
       * and its accessible name / tooltip lead. Omitted, it is the play glyph
       * and "Launch <model>".
       */
      action?: { icon: IconRef; label: string };
    }
);

/**
 * The launch action, generalized over any model choice. `launch(model, e?)`
 * creates a conversation with that choice — a family ("opus") runs its newest
 * version, resolved by the server at spawn. This is the common action the
 * launch plugin exposes; custom UIs (rewind, the launch sidebar item) consume
 * it directly.
 *
 * Launching needs the computer (`createConversation` is `needsMachine`):
 * `availability` says so before a click, and a surface renders its control
 * disabled with the message. `launch` under an unavailable answer rejects
 * with it — never resolves as if a conversation started.
 */
export function useLaunchConversation({
  getRequest,
  openAfterLaunch = true,
  openMode = "push",
  onLaunched,
}: Pick<
  LaunchControlProps,
  "getRequest" | "openAfterLaunch" | "openMode" | "onLaunched"
>) {
  const fetchEndpoint = useFetchEndpoint();
  const availability = useMachineAvailability(createConversation);
  const [launching, setLaunching] = useState<ModelChoice | null>(null);
  const openPane = useOpenPane();

  const launch = async (model: ModelChoice, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (launching) return;
    setLaunching(model);
    try {
      const request = (await getRequest?.()) ?? {};
      const result = await fetchEndpoint(
        createConversation,
        {},
        { body: { model, ...request } },
      );
      if (result.kind === "unavailable") throw new Error(result.message);
      const conversation = result.value;
      onLaunched?.(conversation);
      if (openAfterLaunch)
        openPane(
          conversationPane,
          { convId: conversation.id },
          { mode: openMode },
        );
    } finally {
      setLaunching(null);
    }
  };

  return { launch, launching, availability };
}

/**
 * The model dropdown menu shared by every launch surface: one row per visible
 * model (click = persist it as the default), a hover launch icon per row that
 * fires that model one-time, and mod+N shortcuts launching the Nth model.
 * Render inside a `DropdownMenu` next to whatever trigger the surface uses.
 */
export function LaunchModelMenuContent({
  launch,
}: {
  launch: (model: ModelChoice, e?: React.MouseEvent) => Promise<void> | void;
}) {
  const defaultModel = useDefaultModel();
  const visibleModels = useVisibleModels();
  const setDefaultModel = useSetDefaultModel();

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > visibleModels.length) return;
    e.preventDefault();
    void launch(visibleModels[n - 1]!);
  };

  // The default is the menu's one checked choice: picking a row persists it
  // (and closes the menu, as a plain item would); the row's hover action
  // launches that model once without touching the default.
  return (
    <DropdownMenuContent align="start" onKeyDown={onMenuKeyDown}>
      <DropdownMenuRadioGroup
        value={defaultModel}
        onValueChange={(id: ModelChoice) => setDefaultModel(id)}
      >
        {visibleModels.map((id, i) => (
          <DropdownMenuRadioItem
            key={id}
            value={id}
            closeOnClick
            shortcut={formatShortcutLabel(`mod+${i + 1}`)}
            action={{
              icon: playArrowIcon,
              label: `Launch ${choiceLabel(id)}`,
              onAction: (e) => launch(id, e),
            }}
          >
            <ModelChoiceLabel choice={id} />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  );
}

/**
 * Split [ <model dropdown> | <launch> ] control. The dropdown lists the visible
 * model choices; clicking a row sets it as the persisted default; the hover
 * launch icon on each row fires that model one-time; the main launch button
 * fires the current default.
 */
export function LaunchControl({
  getRequest,
  openAfterLaunch = true,
  openMode = "push",
  onLaunched,
  variant = "default",
  size = "default",
  fullWidth = false,
  disabled,
  className,
  action,
}: LaunchControlProps) {
  const { launch, launching, availability } = useLaunchConversation({
    getRequest,
    openAfterLaunch,
    openMode,
    onLaunched,
  });
  const defaultModel = useDefaultModel();
  // No computer behind this subtree (the demo), or Claude Code missing or
  // signed out: no agent can start, so the control says why (and how to fix
  // it) instead of launching one that dies.
  const claudeCodeBlock = useClaudeCodeLaunchBlock();
  const claudeBlock = availability.available
    ? claudeCodeBlock
    : availability.message;
  const off = disabled || claudeBlock !== null;
  const launchTitle = claudeBlock ?? `Launch ${choiceLabel(defaultModel)}`;

  const busy = off || launching !== null;
  const btnVariant = variant;
  const blue =
    variant === "default"
      ? "bg-primary hover:bg-primary/90 text-primary-foreground"
      : "";

  const rows = <LaunchModelMenuContent launch={launch} />;

  if (size === "icon") {
    return (
      <ButtonGroup className={className}>
        {/* Not an IconButton: the play glyph is sized per model, and a caller
            may swap in its own glyph. */}
        <Button
          variant={variant === "outline" ? "outline" : "ghost"}
          // Outlined, the launch half is the pill's wide end, not a square.
          aspect={variant === "outline" ? "text" : "icon"}
          disabled={busy}
          aria-label={
            action
              ? `${action.label} (${choiceLabel(defaultModel)})`
              : `Launch ${choiceLabel(defaultModel)}`
          }
          tooltip={
            claudeBlock ??
            (action
              ? `${action.label} (${choiceLabel(defaultModel)})`
              : launchTitle)
          }
          onClick={() => launch(defaultModel)}
          className={cn(
            action && "text-muted-foreground",
            variant === "outline" && "bg-transparent",
          )}
        >
          {action ? (
            <Icon icon={action.icon} className="size-3.5" />
          ) : (
            <Icon
              icon={playArrowIcon}
              className={choiceIconSize(defaultModel)}
            />
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant={variant === "outline" ? "outline" : "ghost"}
                aspect="icon"
                disabled={off}
                aria-label="Choose model"
                className={cn(
                  "px-none text-muted-foreground",
                  variant === "outline" && "bg-transparent",
                )}
              />
            }
          >
            <Icon
              icon={keyboardArrowDownIcon}
              className={variant === "outline" ? "size-3.5" : "size-3"}
            />
          </DropdownMenuTrigger>
          {rows}
        </DropdownMenu>
      </ButtonGroup>
    );
  }

  return (
    <ButtonGroup className={cn(fullWidth && "w-full", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant={btnVariant}
              disabled={off}
              // eslint-disable-next-line layout/no-adhoc-layout -- flexible dropdown button absorbing slack inside the (raw) ButtonGroup row and spreading its own label↔chevron; no primitive composes onto the shadcn Button's internal flex
              className={cn(
                "gap-xs",
                blue,
                fullWidth && "flex-1 justify-between",
              )}
            />
          }
        >
          {choiceLabel(defaultModel)}
          <Icon icon={keyboardArrowDownIcon} className="size-4 opacity-80" />
        </DropdownMenuTrigger>
        {rows}
      </DropdownMenu>
      {/* eslint-disable-next-line icon-button/prefer-icon-button -- the second segment of a ButtonGroup split control, not a standalone action: it must match the model button's height and seam, and owns its own px-sm + border-l */}
      <Button
        variant={btnVariant}
        disabled={busy}
        aria-label={`Launch ${choiceLabel(defaultModel)}`}
        tooltip={launchTitle}
        onClick={() => launch(defaultModel)}
        className={cn(
          "px-sm",
          blue,
          variant === "default" && "border-l border-white/20",
        )}
      >
        <Icon icon={playArrowIcon} className="size-4" />
      </Button>
    </ButtonGroup>
  );
}
