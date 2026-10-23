import { defineTour, onSignal } from "@plugins/hints/core";
import { homeApp } from "@plugins/apps/plugins/home/plugins/shell/core";
import {
  appTileAnchor,
  homeGalleryAnchor,
} from "@plugins/apps/plugins/home/plugins/app-cards/core";
import { actionBarAnchor } from "@plugins/shell/plugins/global-action-bar/core";
import {
  improveButtonAnchor,
  improvePanelAnchor,
  improveSendAnchor,
  improveSent,
} from "@plugins/improve/core";
import { openImprove } from "@plugins/improve/web";
import { conversationRowAnchor } from "@plugins/conversations/plugins/conversations-view/plugins/data-view/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { openPane } from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

/**
 * The tour's data: the task the user's first request filed (set when Improve
 * sends), and — once the Agent Manager is near — the conversation working on
 * it and whether its turn is over (`HandoffTracker` resolves both). Plus how
 * the toolbar is drawn right now (`ActionBarTracker`): floating, folded into
 * its dot until hovered (solo), or docked and always open in the tab bar —
 * `null` until the tracker has written it.
 */
export interface HomeTourData {
  readonly taskId: string | null;
  readonly conversationId: string | null;
  readonly ready: boolean;
  readonly barFloating: boolean | null;
}

/**
 * The first request the tour offers: a real change to the screen the user is
 * on, built while they carry on.
 */
export const FIRST_PROMPT =
  "Make my home screen's background follow the time of day — warm at sunrise, bright at noon, deep blue at night";

const mouseIcon = symbol("mouse");
const pickIcon = symbol("ads-click");
const equinIcon = symbol("all-inclusive");

/**
 * Home's tour (the primary one: "Replay the tour" starts it). The welcome
 * card, then the gallery, the toolbar, Improve — where the user can send a
 * first request for real — the Agent Manager tile, and, inside the Agent
 * Manager, the row of the conversation that request started.
 */
export const homeTour = defineTour<HomeTourData>({
  id: "home.tour",
  app: homeApp,
  primary: true,
  autoStart: true,
  intro: {
    icon: equinIcon,
    title: "Welcome to equin",
    body: "An app that builds itself. You say what you want; agents build it in the background while you keep working.",
    note: "A few quick stops · about a minute",
  },
  initialData: {
    taskId: null,
    conversationId: null,
    ready: false,
    barFloating: null,
  },
  steps: [
    {
      id: "apps",
      anchor: homeGalleryAnchor,
      padding: 14,
      title: "Your apps",
      body: "Customize any app, or create new ones.",
    },
    {
      id: "bar",
      anchor: actionBarAnchor,
      title: "Your way to talk to equin",
      // Floating (solo), the bar is a dot that unfolds on hover, and hovering
      // it is the step's gesture. Docked in the tab bar it is always open:
      // nothing to unfold, so only Next moves on.
      body: (d) =>
        d.barFloating
          ? "This toolbar is how you interact with the app: ask for changes, get notified, get help. It's on every app, folded into this dot to stay out of your way."
          : "This toolbar is how you interact with the app: ask for changes, get notified, get help. It's on every app, up here in the tab bar.",
      footnote: (d) =>
        d.barFloating ? (
          <>
            <Icon icon={mouseIcon} />
            Hover it to unfold
          </>
        ) : null,
      advanceOn: (d) => (d.barFloating ? "anchor-hover" : null),
    },
    {
      id: "improve",
      anchor: improveButtonAnchor,
      title: "Improve anything you see",
      body: (
        <>
          Spot a bug, a rough edge, an idea? Click <b>Improve</b> and say it —{" "}
          <Icon icon={pickIcon} /> points at the exact element. An agent works
          on it in the background while you carry on.
        </>
      ),
      // Clicking Improve itself is "Try it" done by hand: the popover the
      // click opened gets the first request too (a seed fills only an empty
      // draft), and the tour moves on to it.
      next: {
        label: "Try it",
        run: (ctl) => {
          openImprove({ seed: FIRST_PROMPT });
          ctl.go("ask");
        },
      },
      advanceOn: "anchor-click",
      alt: { label: "Skip", to: "agents" },
    },
    {
      // Improve is open: the card stays beside it, Send ringed. Sending moves
      // on; closing it unsent goes back a step.
      id: "ask",
      anchor: improvePanelAnchor,
      cue: improveSendAnchor,
      title: "See what an agent can do",
      body: "Here's a first request — a real change to this screen, built while you carry on. Send it as is, or make it yours.",
      next: "none",
      alt: { label: "Skip", to: "agents" },
      onAnchorLost: "improve",
      advanceOn: onSignal(improveSent, {
        update: (d: HomeTourData, p: { taskIds: string[] }) => ({
          ...d,
          taskId: p.taskIds[0] ?? null,
        }),
        to: "agents",
      }),
    },
    {
      id: "agents",
      anchor: appTileAnchor.at(agentManagerApp.id),
      title: (d) =>
        d.taskId ? "Your agent is on it" : "Agent work comes back here",
      body: (d) =>
        d.taskId
          ? "It works in the background — usually a few minutes, so there's no need to wait. Its conversation lives in the Agent Manager."
          : "Agents work in the background, 10 minutes to an hour. Their conversations live in the Agent Manager.",
      back: "improve",
      next: {
        label: "Open Agent Manager",
        run: (ctl) => {
          ctl.navigate(agentManagerApp.basePath);
          // A request was sent: the handoff shows it, waiting for its
          // conversation if the agent has not started yet. Nothing sent:
          // there is no conversation to point at, so the tour ends here.
          if (ctl.data.taskId) ctl.next();
          else ctl.end("completed");
        },
      },
    },
    {
      // In the Agent Manager, on the row of the conversation the request
      // started. Until that row exists (the launch is asynchronous; with
      // auto-start off it never comes) the card waits centered, saying so,
      // with Finish tour — so the tour can always end. Opening the row ends
      // the tour as it would.
      id: "handoff",
      anchor: (d) =>
        d.conversationId ? conversationRowAnchor.at(d.conversationId) : null,
      placement: "right",
      title: (d) => (d.ready ? "Your request is ready" : "Here's your request"),
      body: (d) =>
        d.conversationId === null
          ? "The agent is starting on it — its conversation shows up in the sidebar in a moment. No need to wait here."
          : d.ready
            ? "The agent finished it. Open it to see what it built."
            : "The agent is building it now — it'll be ready in a few minutes. No need to wait here.",
      back: null,
      advanceOn: "anchor-click",
      next: {
        label: (d) => (d.ready ? "Open it" : "Finish tour"),
        run: (ctl) => {
          // Clicking the row (`via: "anchor"`) already opened it.
          const convId = ctl.data.conversationId;
          if (ctl.via === "button" && ctl.data.ready && convId)
            openPane(conversationPane, { convId }, { mode: "root" });
          ctl.end("completed");
        },
      },
    },
  ],
});
