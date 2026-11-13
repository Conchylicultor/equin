import { namespaceFromHost } from "@plugins/infra/plugins/namespace/core";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  REPLAY_PROTOCOL,
  ReplayCommandSchema,
  stripQuery,
  type ReplayCommand,
  type ReplayFrameMessage,
} from "../../core";

/**
 * The framed site's half of the session replay (`core/internal/replay.ts`):
 * the deploy app plays a recorded visit in a frame of the site's LOCAL serve
 * and asks it, over `postMessage`, to go to a page in-app and to scroll a
 * section into view.
 *
 * Installed only when the page is served on this computer's gateway (an
 * app namespace's host) AND framed: a deployed site on its public host never
 * listens. A command is honoured only from the frame's own parent, on an app
 * namespace's origin — the equin app on this computer, never the content host — and only once it
 * parses; anything else is ignored.
 */
export interface ReplayFollowDeps {
  /** The page's own host (`location.host`). */
  host: string;
  /** The window framing this page, or null when it is not framed. */
  parent: Window | null;
  /** In-app navigation to a path (`apps-core/tabs`' `navigate`). */
  navigate: (path: string) => void;
  /** The page's route path now. */
  currentPath: () => string;
  /** The mounted element of `path`'s section `name`, or null. */
  sectionElement: (path: string, name: string) => Element | null;
  /** `path`'s registered sections, in page order. */
  sectionsOf: (path: string) => readonly string[];
  addMessageListener: (fn: (e: MessageEvent) => void) => void;
}

/** A host this computer's gateway serves an app namespace on (never the content host). */
const isNamespaceHost = (host: string) => namespaceFromHost(host) !== null;

function originIsLocal(origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  return isNamespaceHost(new URL(origin).host);
}

/**
 * Starts following replay commands, when this page is a local serve in a
 * frame; returns whether it did. Tells the parent it is ready (no data but
 * the protocol: the target origin is unknown until a command arrives).
 */
export function followReplay(deps: ReplayFollowDeps): boolean {
  const parent = deps.parent;
  if (parent === null || !isNamespaceHost(deps.host)) return false;
  deps.addMessageListener((e) => {
    if (e.source !== parent || !originIsLocal(e.origin)) return;
    const parsed = ReplayCommandSchema.safeParse(e.data);
    if (!parsed.success) return;
    run(parsed.data, deps);
  });
  const ready: ReplayFrameMessage = {
    protocol: REPLAY_PROTOCOL,
    kind: "ready",
  };
  parent.postMessage(ready, "*");
  return true;
}

/** A section is shown from its top, the scroll eased as a reader's would be. */
const REVEAL = { behavior: "smooth", block: "start" } as const;

function run(command: ReplayCommand, deps: ReplayFollowDeps): void {
  const here = stripQuery(deps.currentPath());
  switch (command.kind) {
    case "navigate":
      if (command.path !== here) deps.navigate(command.path);
      return;
    case "scroll-to": {
      // Not mounted (yet, or this build of the page has no such section):
      // nothing to aim at — the replay goes on without the scroll.
      revealElement(deps.sectionElement(here, command.section), REVEAL);
      return;
    }
    case "scroll-top": {
      // The page's top is its first section; a page with none has no
      // section to aim at, and stays where it is.
      const first = deps.sectionsOf(here)[0];
      if (first !== undefined)
        revealElement(deps.sectionElement(here, first), REVEAL);
      return;
    }
  }
}
