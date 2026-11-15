import { useMemo } from "react";
import type { EmbedPlaceBinding } from "@plugins/apps-core/plugins/app-embed/web";
import type { DemoEntry } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import {
  defineScopedStore,
  type ScopedStore,
} from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";

/** Which page draws the demo: framed on the homepage, or the demo page itself. */
export type DemoTargetKind = "framed" | "page";

/** The box a page draws the demo in (`DemoTarget`). */
export interface DemoTargetEntry {
  kind: DemoTargetKind;
  element: HTMLElement;
  /**
   * Where the page keeps the embed's place — the demo page's embed tail.
   * `null`: the framed demo, whose place is this store's memory.
   */
  place: EmbedPlaceBinding | null;
}

/** The live demo's state for the visit: one per site surface (`DemoResident`'s provider). */
export interface DemoState {
  /** The box the demo is drawn in now, `null` on a page without one. */
  target: DemoTargetEntry | null;
  /** The kind of the last box that claimed the demo. */
  lastKind: DemoTargetKind | null;
  /** Where the framed demo's controls (Maximize, Reset) go. */
  controls: HTMLElement | null;
  /**
   * The first page asked for the demo: the resident mounts its scope from
   * then on, for the rest of the visit — never before (a site page without
   * the demo starts nothing), never again (a page switch keeps the server).
   */
  started: { resume: true | undefined } | null;
  /** The visitor came in (the gate, a join, or the demo page): the frame stays grown. */
  entered: boolean;
  /** How many times the visitor clicked Enter at the gate (the homepage scrolls to the frame). */
  gateEntries: number;
  /** Where the visitor is inside the demo, as last reported (`undefined`: nowhere chosen). */
  place: string | undefined;
  /** The demo page was left for the frame: the homepage reveals it. */
  returning: boolean;
  /**
   * The demo page shows because the visitor maximized the homepage's frame
   * (not a link, not the apps gallery): it offers the way back. Cleared when
   * the page is left.
   */
  viaMaximize: boolean;
}

const DemoStore = defineScopedStore<DemoState>({
  target: null,
  lastKind: null,
  controls: null,
  started: null,
  entered: false,
  gateEntries: 0,
  place: undefined,
  returning: false,
  viaMaximize: false,
});

/** The store's scope: one per site surface, around its pages and the resident. */
export const DemoStoreProvider = DemoStore.Provider;

/** The live demo's state, live. */
export function useDemoState(): DemoState {
  return DemoStore.useStore();
}

/** What a page, the band and the resident do to the demo's state. */
export interface DemoActions {
  /** The state now, for a handler. */
  peek(): DemoState;
  /**
   * A page's box takes the demo. Returns its release (only its own: a page
   * that already replaced it keeps the demo).
   */
  claimTarget(kind: DemoTargetKind, element: HTMLElement): () => void;
  /** The demo page hands its place binding to the box it claimed. */
  bindTargetPlace(element: HTMLElement, place: EmbedPlaceBinding | null): void;
  /** The homepage revealed the frame it came back to: was there one to reveal? */
  consumeReturn(): boolean;
  /** Where the framed demo's controls go (`null` when the row unmounts). */
  setControls(element: HTMLElement | null): void;
  /** Where the visitor is inside the demo (`undefined`: forget it — a Reset). */
  setPlace(place: string | undefined): void;
  /** The visitor came in through the scope's gate or a join. */
  entered(how: DemoEntry): void;
  /** The visitor maximized the frame: the demo page about to show offers the way back. */
  maximizing(): void;
}

/** {@link DemoActions} over the enclosing scope's store. */
export function useDemoActions(): DemoActions {
  const store = DemoStore.useStoreApi();
  return useMemo(() => demoActions(store), [store]);
}

function demoActions(store: ScopedStore<DemoState>): DemoActions {
  const update = (next: Partial<DemoState>) =>
    store.setState((s) => ({ ...s, ...next }));
  return {
    peek: () => store.getState(),
    claimTarget(kind, element) {
      const s = store.getState();
      update({
        target: { kind, element, place: null },
        lastKind: kind,
        started: s.started ?? { resume: kind === "page" ? true : undefined },
        entered: s.entered || kind === "page",
        returning: kind === "framed" && s.lastKind === "page",
      });
      return () => {
        if (store.getState().target?.element !== element) return;
        update(
          kind === "page"
            ? { target: null, viaMaximize: false }
            : { target: null },
        );
      };
    },
    bindTargetPlace(element, place) {
      const target = store.getState().target;
      if (
        target === null ||
        target.element !== element ||
        target.place === place
      )
        return;
      update({ target: { ...target, place } });
    },
    consumeReturn() {
      if (!store.getState().returning) return false;
      update({ returning: false });
      return true;
    },
    setControls(element) {
      if (store.getState().controls !== element) update({ controls: element });
    },
    setPlace(place) {
      if (store.getState().place !== place) update({ place });
    },
    maximizing() {
      update({ viaMaximize: true });
    },
    entered(how) {
      const s = store.getState();
      update({
        entered: true,
        gateEntries: s.gateEntries + (how === "gate" ? 1 : 0),
      });
    },
  };
}
