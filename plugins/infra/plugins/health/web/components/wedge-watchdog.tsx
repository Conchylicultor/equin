import { useEffect, useRef } from "react";
import {
  subscribeNetDiag,
  subscribeWsStatus,
  type NetDiagEvent,
} from "@plugins/primitives/plugins/networking/web";
import {
  describeUnansweredTrail,
  getNotificationsClient,
  liveStateSocketKind,
  unansweredSubReportSink,
  useNotificationsChannelStatuses,
  type UnansweredServer,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { getHealth } from "../internal/client";
import { PUSH_STALL_MS } from "../internal/push-stall";
import { wedgeReportSink } from "../internal/wedge-report-sink";
import { createVisibleDeadlines } from "../internal/visible-deadline";

// How long a socket may stay non-open before we declare the live-state pipeline
// wedged. A transient reconnect self-heals well within this window via sub-ack;
// only a truly stuck socket survives it.
const SOCKET_DOWN_MS = 15_000;

// Per-discriminator cooldown so a flapping pipeline doesn't spam toasts + crash
// reports.
const WEDGE_COOLDOWN_MS = 60_000;

// Module-level cooldown clock, keyed by discriminator (so independent failure
// modes — e.g. a post-restart wedge vs a silent-drop one — never throttle each
// other). Survives component remounts so a flapping pipeline that
// tears the watcher down and back up still throttles.
const lastWedgeAt = new Map<string, number>();

/** How a report names the server an unanswered sub was sent to. */
const UNANSWERED_SERVER_LABEL: Record<UnansweredServer, string> = {
  worktree: "worktree",
  central: "central",
  "in-browser": "in-browser server",
};

type WedgeKind =
  | "socket-down"
  | "missed-updates"
  | "connect-stalled"
  | "port-evicted"
  | "unanswered-sub"
  | "push-stall"
  | "push-stall-resource";

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
// live-state rather than sniffed from the url; a fact the tab established about
// the cause (the server restarted: `:restart`) splits a mode into its own task —
// but stays key-agnostic within each, so a broad pipeline wedge files ONE task,
// not one per stuck resource (the key stays in the message + count for triage).
// The two modes that measure ONE resource are keyed by it: a stuck resource
// push (`push-stall-resource`) and an unanswered sub (`unanswered-sub`, by
// the server that left it unanswered and its oldest key) — each such wait has
// its own cause (one loader, one key's watch), so one fingerprint for every
// key and server made a fix of one read as regressed by the next, and let a
// server in this browser's wedge hide the page backend's under the cooldown.
// No volatile data (versions, params) enters this, so each mode still dedups
// into a single task.
//
// Every wedge is a fault and is reported loud: none is "benign". A signal that
// cannot establish its fault — a wait that spanned a page suspension — does not
// fire at all (its deadline restarts once the page runs again: `firedLate`,
// visible-only deadlines), rather than firing and asking for a mute. Every
// toast is a developer one: this is equin's own telemetry, and the health
// report's Connection row already tells a user their live state.
function wedge(
  kind: WedgeKind,
  discriminator: string,
  detail: string,
  opts: { description?: string } = {},
): void {
  const now = Date.now();
  const prev = lastWedgeAt.get(discriminator);
  if (prev !== undefined && now - prev < WEDGE_COOLDOWN_MS) return;
  lastWedgeAt.set(discriminator, now);

  showToast({
    title: "Live updates stalled",
    description:
      opts.description ?? "Reconnecting… refresh if data looks stale",
    variant: "warning",
    audience: "developer",
  });

  // Emit onto the neutral wedge sink; `reports.crash` (when present) maps it to a
  // deduped crash task. The discriminator gives each failure mode a distinct
  // fingerprint; the stable message still dedups repeats of a given mode into one
  // growing-count task. emit() never throws (the sink swallows on the error path).
  wedgeReportSink.emit({
    discriminator,
    message: `live-state wedged: ${kind} — ${detail}`,
  });
}

/**
 * No-render Core.Root watchdog that detects a wedged client live-state pipeline
 * and surfaces it loudly (transient toast + deduped crash task). Detection is
 * fully event/transition-driven with single armed timeouts — no polling.
 */
export function WedgeWatchdog() {
  // --- Signal 5: a server whose pushes stopped on an open socket ---
  // The heartbeat's stall report is the only frame that still arrives, so the
  // tab is the one place that can report it. The same threshold drives the
  // Connection row. Two shapes, reported apart:
  // - `pushStallMs`: EVERY push stopped (a flush that never settles) — one
  //   report per channel per episode;
  // - `stalledResources`: one resource's drain stuck while the rest flow (a
  //   leaf loader hung on the filesystem) — one report per resource key per
  //   channel per episode, the key in the discriminator: each is its own bug.
  // An episode ends when the age drops back under the threshold (delivered,
  // or the socket changed status).
  const statuses = useNotificationsChannelStatuses();
  const stalled = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set<string>();
    for (const kind of ["worktree", "central"] as const) {
      if (statuses[kind] !== "open") continue;
      const ms = statuses.serverPushStallMs[kind];
      if (ms >= PUSH_STALL_MS) {
        const id = `push-stall:${kind}`;
        now.add(id);
        if (!stalled.current.has(id))
          wedge(
            "push-stall",
            id,
            `the ${kind} server's oldest change has gone undelivered for ${Math.round(ms / 1000)}s on an open socket`,
            {
              description:
                "Changes are saved but won't appear until the server restarts",
            },
          );
      }
      // Every push stopped covers its lanes too: "while every other push
      // flows" would be false (a barrier entry awaiting a leaf's lane).
      if (ms >= PUSH_STALL_MS) continue;
      for (const r of statuses.serverStalledResources[kind]) {
        if (r.ms < PUSH_STALL_MS) continue;
        const id = `push-stall-resource:${kind}:${r.key}`;
        now.add(id);
        if (!stalled.current.has(id))
          wedge(
            "push-stall-resource",
            id,
            `the ${kind} server's push of ${r.key} has been stuck for ${Math.round(r.ms / 1000)}s while every other push flows`,
            {
              description: `${r.key} isn't updating — everything else is`,
            },
          );
      }
    }
    stalled.current = now;
  }, [statuses]);

  useEffect(() => {
    // --- Page suspension ---
    // A hidden page may be frozen (a phone: on screen lock or app switch), its
    // timers paused and its sockets dropped by the OS. Every signal that
    // measures elapsed time counts visible time only (`visible-deadline.ts`).
    const deadlines = createVisibleDeadlines({
      now: () => Date.now(),
      isHidden: () => document.visibilityState === "hidden",
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });

    // --- Signal 1: socket-down wedge ---
    // One deadline per url: armed on connecting/reconnecting/closed, cleared
    // on open, elapsed after SOCKET_DOWN_MS of visible time in total.
    const unsubWs = subscribeWsStatus(({ url, status }) => {
      // The status bus is global across EVERY app socket (logs, terminal,
      // build, …). Only the live-state pipeline sockets count toward a
      // live-state wedge — an unrelated socket's downtime (e.g. a build popover
      // left open while the server restarts) must not file a live-state crash.
      const channelKind = liveStateSocketKind(url);
      if (channelKind === null) return;
      if (status === "open") {
        deadlines.clear(url);
      } else {
        // "connecting" counts: a first connect whose handshake never answers
        // fires no event and never becomes "reconnecting" — the socket just
        // stays connecting, which once went 9 minutes unreported.
        deadlines.arm(url, SOCKET_DOWN_MS, () => {
          wedge(
            "socket-down",
            `socket-down:${channelKind}`,
            `${url} (${status})`,
          );
        });
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
        // A wait across a suspension never gets here: the socket owner's
        // deadline restarts once its realm runs again (`firedLate`). A server
        // (re)booting during the attempt held the handshake at the gateway for
        // the whole deadline — a boot that slow is a fault of its own, split
        // into its own task by that fact.
        void getHealth().then((health) => {
          if (health !== null && health.startedAt > stalledSince) {
            wedge(
              "connect-stalled",
              `connect-stalled:${kind}:restart`,
              `${detail}; held by a server boot (up since ${new Date(health.startedAt).toISOString()})`,
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
      // A wait across a suspension never gets here: live-state judges a wait
      // only from when the page could run (its deadline restarts on a late
      // fire). Hidden is not frozen: a hidden tab that runs measures the
      // server's silence as well as a visible one (2026-11-12: hidden tabs
      // measured reports.list:rows unanswered 18–111 s, muted as suspended).
      const visibleMs = deadlines.visibleMsSince(Date.now() - r.oldestWaitMs);
      wedge(
        "unanswered-sub",
        `unanswered-sub:${r.server}:${r.oldestKey}`,
        `${r.count} sub(s) unanswered on an open ${UNANSWERED_SERVER_LABEL[r.server]} socket, oldest ${r.oldestKey} ${r.oldestParams} for ${Math.round(r.oldestWaitMs / 1000)}s (${Math.round(visibleMs / 1000)}s visible; tabs on socket: ${r.attachedTabs ?? "?"}, connection ${r.connection ?? "-"}). Where the server stands on it: ${describeUnansweredTrail(r.trail)}`,
      );
    });

    // --- Signal 2: missed-updates wedge + self-heal ---
    // On hidden→visible, run the client probe (forces a resync — also a cheap
    // stale-cache self-heal — and reports only genuinely-missed subs). The probe
    // self-resolves after its settle window; an in-flight guard ignores rapid
    // re-focus while one is running.
    //
    // A missed-updates gap is split by one fact: whether the server restarted
    // *while this tab was backgrounded* (`startedAt` advancing past the hidden
    // timestamp). Either way the tab held a stale value it was never told
    // about until this probe — the reconnect's replay should have resynced it
    // — so both are faults, reported loud as two tasks (a restart-path miss
    // and a silent drop on a live socket are different bugs).
    let hiddenAt: number | null = null;
    let probing = false;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        deadlines.onHidden();
        return;
      }
      if (document.visibilityState !== "visible") return;
      deadlines.onVisible();
      if (probing) return;
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
            wedge(
              "missed-updates",
              "missed-updates:restart",
              `${detail}; the server restarted while this tab was hidden`,
            );
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
      deadlines.clearAll();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
