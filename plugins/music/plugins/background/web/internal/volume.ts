import { useSyncExternalStore } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

/** The volume a page starts at before the listener has picked one. */
const DEFAULT_VOLUME = 0.6;

// Per device, like a speaker's knob — and shared by the browser's tabs, which
// the store's subscribe already follows.
const volumeStore = defineStore({
  owner: "music.background",
  pageWide: {
    reason: "the device's background music volume, one for the page",
  },
  label: "Background music volume",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.number().min(0).max(1),
});

function readVolume(): number {
  const read = volumeStore.read("volume");
  return read.kind === "value" ? read.value : DEFAULT_VOLUME;
}

function subscribe(listener: () => void): () => void {
  return volumeStore.subscribe("volume", listener);
}

/** The slider's position, 0..1. */
export function useVolume(): number {
  return useSyncExternalStore(subscribe, readVolume, readVolume);
}

export function setVolume(volume: number): void {
  // A refused write is announced by web-storage itself (its health toast);
  // the volume then lives in memory for this page.
  volumeStore.write("volume", Math.max(0, Math.min(1, volume)));
}

/** A slider position as a gain: loudness is heard on a log scale, so the square. */
export function gainOf(volume: number): number {
  return volume * volume;
}
