import { Icon } from "@plugins/ui/plugins/icons/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo, useState } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";

import {
  isDraftEmpty,
  conversationPane,
  useAttemptWorkspaceKind,
} from "@plugins/conversations/plugins/conversation-view/web";
import {
  useHasActiveSiblingInWorktree,
  useConversationById,
} from "@plugins/conversations/web";
import { isAgentBusy, stopConversation } from "@plugins/conversations/core";
import { useHintAnchor, useHintMoment } from "@plugins/hints/web";
import {
  closeHint,
  goHint,
  mainActionAnchor,
  pushAndCloseHint,
} from "../../core";
import {
  getEndpointErrorMessage,
  EndpointError,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import type { MachineResult } from "@plugins/infra/plugins/endpoints/core";
import {
  conversationPromptDraft,
  useSendConversationTurn,
  useTurnAwaitingStart,
  useTurnSendAvailability,
  useTurnSendInFlight,
} from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { useConfig } from "@plugins/config_v2/web";
import { pushAndExitConfig } from "../../shared";
import { pushAndExitDelivery } from "../internal/delivery";
import { resumeConversationEndpoint } from "@plugins/conversations/plugins/conversation-view/plugins/resume/core";
import { exitConversation } from "@plugins/conversations/plugins/conversation-view/plugins/exit/core";
import { dropAndExit } from "@plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/core";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { combineResources } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { attemptWork } from "@plugins/tasks/plugins/attempt-work/core";
import { useEditedFiles } from "@plugins/conversations/plugins/conversation-view/plugins/code/web";
import type { PromptEditorActionProps } from "@plugins/primitives/plugins/prompt-editor/web";
import {
  deriveExitMode,
  exitWorkspace,
  type ExitReads,
  type Mode,
} from "./exit-mode";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

const deleteForeverIcon = symbol("delete-forever");
const errorIcon = symbol("error");
const logoutIcon = symbol("logout");
const playArrowIcon = symbol("play-arrow");
const playlistAddIcon = symbol("playlist-add");
const replayIcon = symbol("replay");
const rocketLaunchIcon = symbol("rocket-launch");
const sendIcon = symbol("send");
const stopIcon = symbol("stop");

// One action per mode: a `run` thunk owning its typed call (so each mode's
// differing param/body/response types stay encapsulated in its own closure — no
// `any`), plus the verb for the error toast and an optional success toast. A
// single runner (`onClick`) drives all of them, so every action shares the same
// in-flight guard, double-click protection, and error handling — no per-mode
// try/toast duplication.
//
// The turn-sending modes (send / queue / go / push-and-exit) return
// SYNCHRONOUSLY: they hand the turn to `useSendConversationTurn`'s send and the
// pending-turn card owns the echo, the failure state and Retry from there.
// Awaiting a turn POST here would give the button a private, weaker lifecycle
// than the Enter key's — which is exactly how these three drifted into
// bypassing the optimistic path in the first place.
type ActionSpec = {
  verb: string;
  successToast?: string;
  run: () => void | Promise<void>;
};

// Every action here drives the agent, which needs the computer
// (`needsMachine`): on a host without it the button is disabled before a
// click, so an unavailable answer reaching a run is a bug — it fails like any
// other refusal (the runner's toast), never as a success.
function machineValue<T>(result: MachineResult<T>): T {
  if (result.kind === "unavailable") throw new Error(result.message);
  return result.value;
}

// Resume's handler throws HttpError(409, msg) → the server serializes the bare
// message string as the response body. getEndpointErrorMessage only reads
// body.message, so for a plain-string body it would fall back to "HTTP 409"
// and lose the custom message. Prefer a non-empty string body to preserve it.
function endpointErrorText(err: unknown): string {
  if (
    err instanceof EndpointError &&
    typeof err.body === "string" &&
    err.body
  ) {
    return err.body;
  }
  return getEndpointErrorMessage(err);
}

// Colour only. The icon/label gap is Button's own (`gap-1.5` at its default
// size), so these overrides used to restate it — invisibly, because a class
// string reached through an identifier was outside every no-adhoc-* rule.
const PRIMARY = "bg-primary hover:bg-primary/90 text-primary-foreground";

// The prompt's one primary action carries the type-scale's strong control
// weight (`font-control-strong`, default = every button's control weight).
const STRONG = "font-control-strong";

const ICONS: Record<Mode, IconRef> = {
  restore: replayIcon,
  send: sendIcon,
  queue: playlistAddIcon,
  stop: stopIcon,
  go: playArrowIcon,
  "push-and-exit": rocketLaunchIcon,
  exit: logoutIcon,
  "exit-error": errorIcon,
  "exit-unavailable": logoutIcon,
  "drop-and-exit": deleteForeverIcon,
};

const BUTTON_CLASS: Record<Mode, string> = {
  restore: PRIMARY,
  send: PRIMARY,
  queue: PRIMARY,
  // The solid fills, not the status colours: a theme can deepen the buttons
  // without darkening every success / error dot, badge and message.
  go: "bg-success-solid hover:bg-success-solid/90 text-success-solid-foreground",
  stop: "bg-destructive-solid text-destructive-solid-foreground hover:bg-destructive-solid/90",
  "push-and-exit": PRIMARY,
  exit: PRIMARY,
  // Degraded, never destructive: the exit decision is unknown, but closing is
  // always safe.
  "exit-error": PRIMARY,
  "exit-unavailable": PRIMARY,
  "drop-and-exit": PRIMARY,
};

const LABELS: Record<Mode, string> = {
  restore: "Restore",
  send: "Send",
  queue: "Queue",
  stop: "Stop",
  go: "Go",
  "push-and-exit": "Push & Close",
  exit: "Close",
  "exit-error": "Close (state unknown)",
  "exit-unavailable": "Close",
  "drop-and-exit": "Drop & Close",
};

export function PushAndExitButton(_: PromptEditorActionProps) {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  // `useConversationById` answers with the live row (its by-id read).
  const live = conversation;

  const [draft, setDraft, clearDraft] = useDraft(conversationPromptDraft, "", {
    scope: convId,
  });
  const [busy, setBusy] = useState(false);
  const draftRef = useLatestRef(draft);
  // Client-side read of the very prompt the server injects for Push & Close —
  // the echo shows it until the ledger row arrives.
  const { prompt: pushPrompt } = useConfig(pushAndExitConfig);
  // Double-click protection for the turn-sending modes. These runs are
  // synchronous, so `busy` (which spans the thunk) no longer covers them — the
  // shared send state does, and covers rather more: a second click while the
  // first request is still open is blocked no matter which surface started
  // it. The open request only, so queueing further messages stays open once
  // the request has landed.
  const sendInFlight = useTurnSendInFlight(convId);
  const sendConversationTurn = useSendConversationTurn();
  const machine = useTurnSendAvailability();
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  const awaitingStart = useTurnAwaitingStart(convId);

  // Restore / Send / Stop work in every workspace; the edited-files read feeds
  // only a git workspace's exit decision, so it runs only where there is git.
  const workspace = exitWorkspace(
    useAttemptWorkspaceKind(conversation?.attemptId ?? null),
  );

  const filesResult = useEditedFiles(workspace === "git" ? convId : null);
  // Where this attempt stands relative to `main`, measured from git rather than
  // read off the push ledger — so the destructive Drop-vs-Push default can never
  // be decided by how far a background ingest job happens to have got. The
  // subscription is per attempt because the standing is a fact about this attempt
  // and nothing else.
  // Skipped (still pending) until the conversation — and with it the attempt
  // id — has loaded; the gate below keeps the neutral "Exit" meanwhile.
  const workResult = useLive(
    attemptWork,
    conversation?.attemptId ? { attemptId: conversation.attemptId } : null,
  );
  // Derived slice: only re-renders when this worktree's sibling-active answer
  // flips, not on every conversations push. `conversation` may be null on first
  // render — the value is only consumed below after the `!conversation` guard.
  const siblingResult = useHasActiveSiblingInWorktree(
    conversation?.worktreePath ?? "",
    convId,
  );
  // The exit-vs-drop decision reads THREE independently-arriving resources
  // (the attempt standing + the conversations sibling slice + edited-files). Gate
  // on all together: while any is loading the button shows a neutral disabled
  // "Exit" instead of falling through to the destructive "Drop & Exit" default —
  // or flashing it before edited-files settle into "Push & Exit". A workspace
  // without git has no edited files: its standing (the recorded delivery) and
  // the sibling check decide alone. A standing nobody here can measure (no
  // computer behind this app) leaves no decision to combine.
  const exit = useMemo((): ExitReads => {
    if (workResult.status === "unavailable")
      return { workspace: "unavailable", message: workResult.message };
    if (workspace === "git") {
      // The edited files are measured from git too: unmeasurable here, the
      // decision is not made either way — only the safe Close is offered.
      if (filesResult.status === "unavailable")
        return { workspace: "unavailable", message: filesResult.message };
      return {
        workspace,
        decision: combineResources({
          work: workResult,
          hasSibling: siblingResult,
          files: filesResult,
        }),
      };
    }
    if (workspace === "no-git")
      return {
        workspace,
        decision: combineResources({
          work: workResult,
          hasSibling: siblingResult,
        }),
      };
    return { workspace };
  }, [workspace, workResult, siblingResult, filesResult]);

  const { mode, provisional } = useMemo(
    () =>
      deriveExitMode({
        conversation,
        live,
        draftEmpty: isDraftEmpty(draft),
        awaitingStart,
        exit,
      }),
    [draft, awaitingStart, exit, conversation, live],
  );

  // The main button's tip is for the decision the user faces once the agent is
  // at rest (not mid-turn, nor idle on background work it will wake for): one tip per decision state, each requested only while the
  // button shows it (settled, never provisional). The other modes request
  // nothing. One call per hint: a hint's request is keyed by the hint itself.
  const anchorRef = useHintAnchor(mainActionAnchor);
  const finished = !!live && !isAgentBusy(live.status) && !provisional;
  useHintMoment(pushAndCloseHint, finished && mode === "push-and-exit");
  useHintMoment(closeHint, finished && mode === "exit");
  useHintMoment(goHint, finished && mode === "go");

  if (!conversation || !live) return null;

  const hasSession = !!live.claudeSessionId;
  // `provisional` (data still loading) keeps the neutral mode un-clickable.
  // Double-click protection comes from whichever half owns the in-flight state:
  // `busy` + the button's `loading` prop for the awaited actions, `sendInFlight`
  // for the turn-sending ones whose thunk returns immediately.
  const sendsATurn =
    mode === "send" ||
    mode === "queue" ||
    mode === "go" ||
    mode === "push-and-exit";
  const disabled =
    !machine.available ||
    (mode === "restore"
      ? !hasSession
      : // Only Stop acts on a starting agent: it takes back the turns that
        // wait for it (deriveExitMode).
        (live.status === "starting" && mode !== "stop") ||
        provisional ||
        (sendsATurn && sendInFlight));

  function specFor(m: Mode): ActionSpec | null {
    switch (m) {
      case "restore":
        return {
          verb: "Resume",
          successToast: "Resuming conversation…",
          run: async () => {
            machineValue(
              await fetchEndpoint(resumeConversationEndpoint, { id: convId }),
            );
          },
        };
      case "send":
      case "queue": {
        const current = draftRef.current;
        if (isDraftEmpty(current)) return null;
        return {
          // Same turn send for both; the server skips the C-c interrupt when the
          // agent is working so the turn is queued rather than sent immediately.
          verb: m === "queue" ? "Queue" : "Send",
          run: () => {
            // Clear first, exactly as Enter does: the draft is spent the moment
            // the record exists, and the record holds the text for Retry.
            clearDraft();
            sendConversationTurn(convId, { text: current });
          },
        };
      }
      case "go":
        return {
          verb: "Go",
          run: () => {
            sendConversationTurn(convId, { text: "Go" });
          },
        };
      case "stop":
        return {
          verb: "Stop",
          run: async () => {
            const data = machineValue(
              await fetchEndpoint(stopConversation, { id: convId }),
            );
            if (data.rewindText) setDraft(data.rewindText);
          },
        };
      case "push-and-exit":
        return {
          verb: "Push & Close",
          run: () => {
            // The wrap-up prompt is a turn like any other: echoed, recorded in
            // the ledger, a card if it fails. The echo is read from the same
            // config the server sends verbatim.
            sendConversationTurn(convId, {
              text: pushPrompt,
              delivery: pushAndExitDelivery,
            });
          },
        };
      // Same action either way: closing a conversation touches no task state,
      // so it is safe to offer even when the exit decision is undecidable.
      case "exit":
      case "exit-error":
      case "exit-unavailable":
        return {
          verb: "Close",
          successToast: "Conversation closed",
          run: async () => {
            machineValue(await fetchEndpoint(exitConversation, { id: convId }));
          },
        };
      case "drop-and-exit":
        return {
          verb: "Drop & Close",
          successToast: "Task dropped and conversation closed",
          run: async () => {
            machineValue(await fetchEndpoint(dropAndExit, { id: convId }));
          },
        };
    }
  }

  async function onClick() {
    if (busy || disabled) return;
    const spec = specFor(mode);
    if (!spec) return;
    setBusy(true);
    try {
      await spec.run();
      if (spec.successToast) {
        toast({
          type: "conversation",
          title: spec.verb,
          description: spec.successToast,
          variant: "success",
        });
      }
    } catch (err) {
      toast({
        type: "conversation",
        title: `${spec.verb} failed`,
        description: endpointErrorText(err),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  const label = LABELS[mode];
  const icon = ICONS[mode];
  // Close is still offered without the computer; the tooltip says why Push and
  // Drop are not.
  const tooltip = exit.workspace === "unavailable" ? exit.message : label;

  return (
    <Button
      ref={anchorRef}
      variant="default"
      tooltip={tooltip}
      aria-label={label}
      loading={busy}
      disabled={disabled}
      onClick={onClick}
      className={cn(STRONG, BUTTON_CLASS[mode])}
    >
      <Icon icon={icon} className="size-3.5" />
      {label}
    </Button>
  );
}
