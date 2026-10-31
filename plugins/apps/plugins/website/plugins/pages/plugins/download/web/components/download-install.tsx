import { useState } from "react";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  INSTALL_COMMAND,
  LOCAL_APP_HOST,
  LOCAL_APP_URL,
} from "@plugins/apps/plugins/website/plugins/shell/core";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";
import {
  WebsiteArrow,
  WebsiteBand,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { DownloadCode } from "./download-code";
import { DownloadLink } from "./download-link";
import { DownloadNextSteps } from "./download-next-steps";

const infoIcon = symbol("info");

type Audience = "human" | "agent";

const AUDIENCES = [
  { id: "human", label: "For you" },
  { id: "agent", label: "For your agent" },
] as const;

/** What the installer does, in the order it does it — `install.sh`'s steps. */
const INSTALLER_STEPS = [
  "Installs the Xcode Command Line Tools and mise",
  "Clones equin and installs its pinned toolchain",
  "Offers to install Claude Code, which agents need to run",
  "Starts equin as a background service and runs the first build",
];

/** The same install, said to an agent: run the command, repair, report back. */
const AGENT_PROMPT = `Install equin (${SOURCE_REPO_URL}) on this Mac with its installer: ${INSTALL_COMMAND}
If a step fails, fix it and run the installer again. When it is done, give me the link to the app.`;

/**
 * Deep links that open a new Claude session with the prompt typed in. Nothing
 * runs until the reader presses Enter, which is what makes them safe to offer.
 */
const PROMPT_QUERY = encodeURIComponent(AGENT_PROMPT);
const CLAUDE_CODE_LINK = `claude-cli://open?q=${PROMPT_QUERY}`;
const CLAUDE_APP_LINK = `claude://code/new?q=${PROMPT_QUERY}`;

/**
 * The download page's body: one install, offered two ways — a command the
 * reader pastes into a terminal, or a prompt they hand to their own agent —
 * then the caveats to know before installing, and what to do once it runs.
 *
 * Its column is narrower than the site's measure (820px): a code panel as wide
 * as the homepage's cards leaves the command stranded at one edge. It caps
 * itself inside the band, as the band asks, rather than narrowing the band.
 */
export function DownloadInstall() {
  const [audience, setAudience] = useState<Audience>("human");
  return (
    <WebsiteBand rhythm="closing">
      <Stack gap="2xl" className="mx-auto max-w-[51.25rem]">
        <Stack gap="xl">
          <Stack gap="xs" align="center">
            <SegmentedControl
              options={AUDIENCES}
              value={audience}
              onChange={setAudience}
              variant="ghost"
            />
          </Stack>
          {audience === "human" ? <ForYou /> : <ForYourAgent />}
        </Stack>
        <Disclaimer />
        <DownloadNextSteps />
      </Stack>
    </WebsiteBand>
  );
}

function ForYou() {
  return (
    <Stack gap="lg">
      <Text as="h2" variant="heading" className="tracking-tight">
        One command
      </Text>
      <Stack gap="md">
        <DownloadCode kind="command" text={INSTALL_COMMAND} />
        <Text as="p" variant="body" tone="muted">
          Then open{" "}
          <DownloadLink href={LOCAL_APP_URL}>{LOCAL_APP_HOST}</DownloadLink>
        </Text>
      </Stack>
      <Collapsible>
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground">
          <Stack direction="row" gap="xs" align="center">
            <CollapsibleChevron />
            <Text variant="body">
              What does <code className="font-mono">install.sh</code> do?
            </Text>
          </Stack>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Stack
            as="ol"
            gap="xs"
            className={cn("list-decimal", insetClass({ l: "xl" }))}
          >
            {INSTALLER_STEPS.map((step) => (
              <Text as="li" key={step} variant="body" tone="muted">
                {step}
              </Text>
            ))}
          </Stack>
        </CollapsibleContent>
      </Collapsible>
    </Stack>
  );
}

function ForYourAgent() {
  return (
    <Stack gap="lg">
      <Text as="h2" variant="heading" className="tracking-tight">
        One prompt
      </Text>
      <Stack gap="md">
        <DownloadCode kind="prompt" text={AGENT_PROMPT} />
        <Stack direction="row" gap="sm" wrap>
          <Button
            variant="secondary"
            className="font-semibold"
            render={<a href={CLAUDE_CODE_LINK} />}
            onClick={() => track("download_open_claude_code")}
          >
            Open in Claude Code
            <WebsiteArrow />
          </Button>
          <Button
            variant="outline"
            render={<a href={CLAUDE_APP_LINK} />}
            onClick={() => track("download_open_claude_app")}
          >
            Open in the Claude app
          </Button>
        </Stack>
        <Text as="p" variant="body" tone="muted">
          Opens a new session with the prompt typed in. Nothing runs until you
          press Enter.
        </Text>
      </Stack>
    </Stack>
  );
}

/** What a reader should know before installing: a bold lead, then the why. */
const CAVEATS = [
  {
    lead: "Install can take a while (~15 mins),",
    body: "as all apps get compiled. This part has not yet been optimized.",
  },
  {
    lead: "You are stepping into someone else's OS.",
    body: "The apps were tuned for one person's use, so not everything will be relevant to you yet. Later versions will split the personal parts out.",
  },
];

/** The caveats, as bullets in one bordered note above what to do once it runs. */
function Disclaimer() {
  return (
    <Stack
      direction="row"
      gap="md"
      align="start"
      className={cn(
        "border-border rounded-2xl border",
        insetClass({ x: "lg", y: "md" }),
      )}
    >
      <Icon
        icon={infoIcon}
        aria-hidden
        className={cn("text-muted-foreground size-4", rigidClass())}
      />
      <Stack
        as="ul"
        gap="sm"
        className={cn("list-disc", insetClass({ l: "lg" }))}
      >
        {CAVEATS.map(({ lead, body }) => (
          <Text as="li" key={lead} variant="caption" tone="muted">
            <Text
              variant="caption"
              className="font-semibold text-muted-foreground"
            >
              {lead}
            </Text>{" "}
            {body}
          </Text>
        ))}
      </Stack>
    </Stack>
  );
}
