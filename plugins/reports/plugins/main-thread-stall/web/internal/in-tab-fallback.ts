import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import {
  StallTabSchema,
  type MainThreadStallPayload,
  type StallFrame,
  type StallTab,
} from "../../core";
import { STALL } from "./constants";
import { fileStall } from "./file-stall";
import { topFunction } from "./stall-machine";
import { LOG_CHANNEL } from "./log-channel";

// The detector for a browser without SharedWorker (Chrome for Android before
// 148, some webviews): no other thread can watch this one, so it catches what
// a tab can catch about itself —
// - a stall that RECOVERS: its LoAF entry (≥ REPORT_MIN_MS) files it directly;
// - a stall that never recovers: a 1 Hz heartbeat keeps "alive at T" in
//   sessionStorage while the tab is visible; pagehide and hiding clear it. A
//   frozen tab that gets reloaded never clears it, so the next load of the tab
//   finds it and files the gap (ended: unknown — gone vs killed is lost).

const markerStore = defineStore({
  owner: "reports.main-thread-stall",
  label: "Main-thread stall heartbeat (fallback detector)",
  area: "session",
  cap: "2 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.object({ tab: StallTabSchema, aliveAt: z.number() }),
});

/** File what the previous page of this tab left open, then keep a heartbeat. Returns the disposer. */
export function installInTabFallback(readTab: () => StallTab): {
  onFrame(frame: StallFrame, tab: StallTab): void;
  dispose(): void;
} {
  const now = Date.now();
  const left = markerStore.read();
  markerStore.remove();
  if (left.kind === "value") {
    const gap = now - left.value.aliveAt;
    if (gap >= STALL.REPORT_MIN_MS) {
      void fileStall(
        payload(left.value.tab, left.value.aliveAt, now, "unknown", null),
      );
    } else {
      clientLog(
        LOG_CHANNEL,
        JSON.stringify({
          kind: "near-miss",
          reason: "fallback-gap",
          gapMs: gap,
        }),
      );
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const beat = (): void => {
    markerStore.write("", { tab: readTab(), aliveAt: Date.now() });
  };
  const sync = (): void => {
    const visible = document.visibilityState === "visible";
    if (visible && timer === null) {
      beat();
      // A sanctioned clock (see ../stall-watchdog.worker.ts): only a beat that
      // STOPS can reveal a freeze that never ends.
      timer = setInterval(beat, STALL.PING_MS);
    } else if (!visible && timer !== null) {
      clearInterval(timer);
      timer = null;
      markerStore.remove();
    }
  };
  const onPageHide = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    markerStore.remove();
  };
  const onPageShow = (): void => sync();
  sync();
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  return {
    onFrame(frame, tab) {
      if (frame.durationMs < STALL.REPORT_MIN_MS || !tab.visible) return;
      void fileStall(
        payload(
          tab,
          frame.startedAt,
          frame.startedAt + frame.durationMs,
          "recovered",
          frame,
        ),
      );
    },
    dispose() {
      onPageHide();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    },
  };
}

function payload(
  tab: StallTab,
  startedAt: number,
  endedAt: number,
  ended: "recovered" | "unknown",
  frame: StallFrame | null,
): MainThreadStallPayload {
  return {
    ...tab,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    // The gap runs from the last heartbeat to this load: it includes the
    // reload itself, and the freeze began up to one beat after.
    durationIsLowerBound: false,
    ended,
    detector: "in-tab",
    framesDuring: 0,
    stallFrame: frame,
    frames: [],
    cohort: [],
    topFunction: topFunction(frame),
  };
}
