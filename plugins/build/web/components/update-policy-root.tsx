import { useEffect, useRef, useState } from "react";
import { useReloadReadiness } from "@plugins/primitives/plugins/dom/plugins/reload-readiness/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useStaleFrontend } from "../hooks/use-stale-frontend";
import { useTabUpdate } from "../hooks/use-tab-update";
import {
  IDLE_BEFORE_UPDATE_MS,
  isPending,
  updateMoment,
} from "../internal/update-policy";
import { quietUpdate, updateArrival } from "../internal/update-state";

/** The channel the policy narrates its decisions on (`~/.equin/worktrees/<wt>/logs`). */
const LOG = "tab-update";

/**
 * The reload policy, once per page (`Core.Root`): a tab running an older build
 * than the one served updates itself at a safe moment — hidden, or visible and
 * idle, or at once when the old build already fails here — through
 * `quietReload`, so the update is lossless and needs no click. See
 * `internal/update-policy.ts` for the branches.
 *
 * It draws nothing: the Update pill shows the pending update the whole time,
 * so a click needs no moment. What it keeps is whether an update reload already
 * came back behind on the same target (`blocked` — reloading again would loop,
 * so the update is left to the pill).
 */
export function UpdatePolicyRoot() {
  const update = useTabUpdate();
  const readiness = useReloadReadiness();
  const { current } = useStaleFrontend();
  const toast = useToast();
  const [arrival] = useState(updateArrival);
  const pending = isPending(update);
  const target = pending ? update.target : null;
  const blocked = pending && arrival !== null && arrival.target === target;
  // The reloading page's own line dies with it (clientLog buffers), so the
  // record of an update reload is written by the page it loads.
  useEffect(() => {
    if (arrival === null) return;
    clientLog(
      LOG,
      `loaded by an update reload toward ${arrival.target ?? "(graph unknown)"} (${arrival.visible ? "visible" : "hidden"})`,
    );
  }, [arrival]);

  useEffect(() => {
    if (!blocked) return;
    clientLog(
      LOG,
      `an update reload toward ${target ?? "(graph unknown)"} came back still behind (${update.kind}); not reloading again`,
    );
  }, [blocked, target, update.kind]);

  // ── the moment ──
  const moment = updateMoment(update, readiness, blocked);
  // A string, not the verdict object: the verdict is a fresh object on every
  // render, and the idle deadline must survive renders that change nothing.
  const why = pending
    ? `${update.kind}${update.kind === "required" ? ` (${update.why})` : ""}`
    : update.kind;
  const visible = !readiness.hidden;
  const reloading = useRef(false);
  useEffect(() => {
    if (moment === "wait" || reloading.current) return;
    const go = () => {
      reloading.current = true;
      clientLog(
        LOG,
        `updating toward ${target ?? "(graph unknown)"}: ${why}, ${visible ? "visible" : "hidden"}`,
      );
      quietUpdate(target, visible);
    };
    if (moment === "reload-now") {
      go();
      return;
    }
    const timer = setTimeout(go, IDLE_BEFORE_UPDATE_MS);
    return () => clearTimeout(timer);
  }, [moment, target, why, visible]);

  // ── after a visible update: say so, once the page is known to have landed ──
  const toasted = useRef(false);
  useEffect(() => {
    if (toasted.current || arrival === null || !arrival.visible || !current)
      return;
    toasted.current = true;
    toast({
      kind: "announcement",
      type: "app-updated",
      title: "Updated to the latest version",
      description: "",
      category: "updates",
    });
  }, [arrival, current, toast]);

  return null;
}
