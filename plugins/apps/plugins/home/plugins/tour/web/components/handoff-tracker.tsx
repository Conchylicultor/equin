import { useEffect } from "react";
import { setTourData, useTourRun } from "@plugins/hints/web";
import { useConversations } from "@plugins/conversations/web";
import { isAgentBusy } from "@plugins/conversations/core";
import { homeTour, type HomeTourData } from "../internal/tour";

/** The steps that read the request's conversation. */
const TRACKED_STEPS: ReadonlySet<string> = new Set(["agents", "handoff"]);

/**
 * Feeds the Home tour the conversation its first request started — data only
 * the page knows. Mounted at `Core.Root` beside the hints host; it reads the
 * conversations only while the tour is on a step that names one (and a
 * request was sent), so the rest of the time it subscribes to nothing.
 */
export function HandoffTracker() {
  const run = useTourRun(homeTour);
  if (
    run?.phase !== "step" ||
    !TRACKED_STEPS.has(run.stepId) ||
    run.data.taskId === null
  )
    return null;
  return <ResolveConversation taskId={run.data.taskId} data={run.data} />;
}

function ResolveConversation({
  taskId,
  data,
}: {
  taskId: string;
  data: HomeTourData;
}) {
  const conversations = useConversations();
  // Not known yet is not "no conversation": write nothing until the read lands.
  const known = conversations.status === "ready";
  const conv = known
    ? (conversations.data.active.find((c) => c.taskId === taskId) ?? null)
    : null;
  const conversationId = conv?.id ?? null;
  // Ready once the agent is at rest — not while it is still starting (a
  // fresh launch) or waiting on its own background work.
  const ready = conv !== null && !isAgentBusy(conv.status);

  useEffect(() => {
    if (!known) return;
    if (conversationId === data.conversationId && ready === data.ready) return;
    setTourData(homeTour, { conversationId, ready });
  }, [known, conversationId, ready, data.conversationId, data.ready]);

  return null;
}
