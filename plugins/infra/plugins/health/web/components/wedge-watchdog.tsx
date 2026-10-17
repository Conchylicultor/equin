import { useEffect } from "react";
import {
  subscribeNetDiag,
  subscribeWsStatus,
  type NetDiagEvent,
} from "@plugins/primitives/plugins/networking/web";
import {
  getNotificationsClient,
  liveStateSocketKind,
  unansweredSubReportSink,
} from "@plugins/primitives/plugins/live-state/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { getHealth } from "../internal/client";
import { wedgeReportSink } from "../internal/wedge-report-sink";

// How long a socket may stay non-open before we declare the live-state pipeline
// wedged. A transient reconnect self-heals well within this window via sub-ack;
// only a truly stuck socket survives it.
const SOCKET_DOWN_MS = 15_000;

// Per-discriminator cooldown so a flapping pipeline doesn't spam toasts + crash
// reports.
const WEDGE_COOLDOWN_MS = 60_000;

// Module-level cooldown clock, keyed by discriminator (so independent failure
// modes — e.g. a benign post-restart wedge vs a genuine silent-drop one — never
// throttle each other). Survives component remounts so a flapping pipeline that
// tears the watcher down and back up still throttles.
const lastWedgeAt = new Map<string, number>();

type WedgeKind =
  | "socket-down"
  | "missed-updates"
  | "connect-stalled"
  | "port-evicted"
  | "unanswered-sub";

// A net-diag event's url is the absolute socket url the worker dialed; the
// live-state classifier keys on the path.
function diagSocketKind(url: string) {
  return liveStateSocketKind(new URL(url).pathname);
}

// Stable per-failure-mode discriminator folded into the crash `errorType`. The
// crash fingerprint is sha256(errorType + stack), and wedges carry no stack — so
// this is what keeps the failure modes from collapsing into one fingerprint and
// one growing-count task. socket-down splits by channel (worktree vs central —
// distinct failure domains, only two values), classified authoritatively by
// live-state rather than sniffed from the url; missed-updates splits genuine
// silent-drop ("missed-updates", loud) from benign deploy-skew
// ("missed-updates:restart", muted server-side) so the two never share a task —
// but stays key-agnostic within each, so a broad pipeline wedge files ONE task,
// not one per stuck resource (the key stays in the message + count for triage).
// No volatile data (versions, params) enters this, so each mode still dedups
// into a single task.
//
// `benign` deploy-skew wedges are expected (the socket missed version bumps while
// the server restarted) — they file a (muted) task for the record but skip the
// user-facing "stalled" toast, which would just be noise on every deploy.
function wedge(
  kind: WedgeKind,
  discriminator: string,
  detail: string,
  opts: { benign?: boolean } = {},
): void {
  const now = Date.now();
  const prev = lastWedgeAt.get(discriminator);
  if (prev !== undefined && now - prev < WEDGE_COOLDOWN_MS) return;
  lastWedgeAt.set(discriminator, now);

  if (!opts.benign) {
    showToast({
      title: "Live updates stalled",
      description: "Reconnecting… refresh if data looks stale",
      variant: "warning",
    });
  }

  // Emit onto the neutral wedge sink; `reports.crash` (when present) maps it to a
  // deduped crash task. The discriminator gives each failure mode a distinct
  // fingerprint; the stable message still dedups repeats of a given mode into one
  // growing-count task. emit() never throws (the sink swallows on the error path).
  wedgeReportSink.emit({
    discriminator,
    message: opts.benign
      ? `live-state went stale across a server restart: ${kind} — ${detail}`
      : `live-state wedged: ${kind} — ${detail}`,
  });
}

/**
 * No-render Core.Root watchdog that detects a wedged client live-state pipeline
 * and surfaces it loudly (transient toast + deduped crash task). Detection is
 * fully event/transition-driven with single armed timeouts — no polling.
 */
export function WedgeWatchdog() {
  useEffect(() => {
    // --- Signal 1: socket-down wedge ---
    // One armed timeout per url. Armed on reconnecting/closed, cleared on open.
    const downTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const clearDownTimer = (url: string) => {
      const t = downTimers.get(url);
      if (t) {
        clearTimeout(t);
        downTimers.delete(url);
      }
    };

    const unsubWs = subscribeWsStatus(({ url, status }) => {
      // The status bus is global across EVERY app socket (logs, terminal,
      // build, …). Only the live-state pipeline sockets count toward a
      // live-state wedge — an unrelated socket's downtime (e.g. a build popover
      // left open while the server restarts) must not file a live-state crash.
      const channelKind = liveStateSocketKind(url);
      if (channelKind === null) return;
      if (status === "open") {
        clearDownTimer(url);
      } else {
        // "connecting" counts: a first connect whose handshake never answers
        // fires no event and never becomes "reconnecting" — the socket just
        // stays connecting, which once went 9 minutes unreported.
        if (downTimers.has(url)) return; // already armed for this url
        const timer = setTimeout(() => {
          downTimers.delete(url);
          wedge(
            "socket-down",
            `socket-down:${channelKind}`,
            `${url} (${status})`,
          );
        }, SOCKET_DOWN_MS);
        downTimers.set(url, timer);
      }
    });

    // --- Signal 3: transport faults the networking layer recovers from ---
    // Each recovery (a hung handshake abandoned, an evicted port re-attached)
    // is published BEFORE it heals; reporting it here is what keeps the
    // recovery from hiding the cause.
    const onDiag = (ev: NetDiagEvent) => {
      if (ev.type === "ws-connect-stalled") {
        const kind = diagSocketKind(ev.url);
        if (kind === null) return;
        const detail = `${ev.url} handshake unanswered for ${Math.round(ev.elapsedMs / 1000)}s (attempt ${ev.attempt})`;
        const stalledSince = Date.now() - ev.elapsedMs;
        // A server (re)booting during the attempt legitimately holds the
        // handshake at the gateway; one that was up the whole time did not.
        void getHealth().then((health) => {
          if (health !== null && health.startedAt > stalledSince) {
            wedge(
              "connect-stalled",
              `connect-stalled:${kind}:restart`,
              detail,
              { benign: true },
            );
          } else {
            wedge(
              "connect-stalled",
              `connect-stalled:${kind}`,
              `${detail}; server ${health === null ? "unreachable" : `up since ${new Date(health.startedAt).toISOString()}`}`,
            );
          }
        });
        return;
      }
      if (ev.type === "port-evicted") {
        const kind = diagSocketKind(ev.url);
        if (kind === null) return;
        // The tab's own lock state names the trigger, so it splits the task.
        const lockClass = ev.tabLock.startsWith("aborted:")
          ? "aborted"
          : ev.tabLock;
        wedge(
          "port-evicted",
          `port-evicted:${lockClass}`,
          `${ev.url}: the shared-ws worker released this live tab as gone after ${Math.round(ev.attachedMs / 1000)}s (tab lock: ${ev.tabLock})`,
        );
      }
    };
    const unsubDiag = subscribeNetDiag(onDiag);

    // --- Signal 4: subs the server never answered on an open socket ---
    unansweredSubReportSink.register((r) => {
      wedge(
        "unanswered-sub",
        `unanswered-sub:${r.socket}`,
        `${r.count} sub(s) unanswered on an open ${r.socket} socket, oldest ${r.oldestKey} ${r.oldestParams} for ${Math.round(r.oldestWaitMs / 1000)}s (tabs on socket: ${r.attachedTabs ?? "?"}, connection ${r.connection ?? "-"})`,
      );
    });

    // --- Signal 2: missed-updates wedge + self-heal ---
    // On hidden→visible, run the client probe (forces a resync — also a cheap
    // stale-cache self-heal — and reports only genuinely-missed subs). The probe
    // self-resolves after its settle window; an in-flight guard ignores rapid
    // re-focus while one is running.
    //
    // A missed-updates gap is benign deploy-skew (not a silent-drop wedge) when
    // the server restarted *while this tab was backgrounded* — the socket missed
    // the restart's version bumps. The crash build-id check can't catch this: a
    // tab that lived through a restart is still on the build the server is
    // *currently* serving, so its id matches and server-side staleness detection
    // misses it. `startedAt` advancing past the hidden timestamp is the signal.
    let hiddenAt: number | null = null;
    let probing = false;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (document.visibilityState !== "visible" || probing) return;
      const client = getNotificationsClient();
      if (!client) return; // before first render / outside provider
      const sinceHidden = hiddenAt;
      probing = true;
      void client
        .probeMissedUpdates()
        .then(async (missed) => {
          if (missed.length === 0) return;
          const m = missed[0]!;
          const more = missed.length > 1 ? ` (+${missed.length - 1} more)` : "";
          const detail = `${m.key} ${m.prevVersion}->${m.ackVersion}${more}`;
          const health = await getHealth();
          const restartWhileHidden =
            sinceHidden != null && health != null && health.startedAt > sinceHidden;
          if (restartWhileHidden) {
            wedge("missed-updates", "missed-updates:restart", detail, { benign: true });
          } else {
            wedge("missed-updates", "missed-updates", detail);
          }
        })
        .finally(() => {
          probing = false;
        });
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      unsubWs();
      unsubDiag();
      unansweredSubReportSink.register(null);
      for (const t of downTimers.values()) clearTimeout(t);
      downTimers.clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
