import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { withEmbedMaximized } from "@plugins/primitives/plugins/pane/core";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { WebsiteArrow } from "@plugins/apps/plugins/website/plugins/shell/web";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import "./download-try-demo.css";

/**
 * The homepage with its live demo maximized at no place of its own
 * (`/about;full=1`): the demo opens full screen where it starts by itself, so
 * this page names no place inside it.
 */
const DEMO_URL = websiteApp.basePath + withEmbedMaximized("");

/**
 * The page's last word, for a reader not ready to install: the homepage's live
 * demo, opened full screen. One card as a whole is the link — a drawn
 * miniature of the app with a play disc, a heading, one line saying what the
 * demo is and that its agents are off (they need equin on the reader's
 * machine), and the link line.
 */
export function DownloadTryDemo() {
  const appLinkProps = useAppLinkProps();
  return (
    <Card
      as="button"
      interactive
      className="download-try hover:bg-card rounded-2xl text-left shadow-none"
      {...appLinkProps(DEMO_URL)}
      onClickCapture={() => track("download_try_demo")}
    >
      {/* Side by side while the words keep 16rem; below that the picture
          sits on top. */}
      <Stack direction="row" gap="xl" align="center" wrap>
        <DemoMiniature />
        <Fill className="min-w-64">
          <Stack gap="xs" align="start">
            <Text
              as="span"
              variant="subheading"
              className="font-semibold tracking-[-0.01em]"
            >
              Not ready to install? Try it in your browser
            </Text>
            <Text as="span" variant="body" tone="muted">
              The real app on made-up data, nothing to install. Agents are off:
              they need equin on your machine.
            </Text>
            <Text
              as="span"
              variant="body"
              className="download-try-go font-medium"
            >
              Open the demo
              <WebsiteArrow />
            </Text>
          </Stack>
        </Fill>
      </Stack>
    </Card>
  );
}

/** A miniature of the app — rail, task tree, one open pane — under a play disc. */
function DemoMiniature() {
  return (
    <span aria-hidden className={cn("download-try-mini", rigidClass())}>
      <span className="download-try-rail">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="download-try-tree">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="download-try-pane">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="download-try-play">
        <span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        </span>
      </span>
    </span>
  );
}
