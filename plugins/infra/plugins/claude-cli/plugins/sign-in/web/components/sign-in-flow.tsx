import { useState } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { openInBrowserTab } from "@plugins/primitives/plugins/link-gesture/web";
import type { ClaudeSignInFlow as Flow } from "../../core";
import {
  useClaudeSignInActions,
  type ClaudeSignInActions,
} from "../internal/use-sign-in";

/** A run still in progress, or one that failed — what the panel shows. */
export type OpenSignInFlow = Extract<Flow, { kind: "waiting" | "failed" }>;

type Actions = Extract<ClaudeSignInActions, { kind: "available" }>;

/** Where the user finishes signing in: Claude, or the Console for a Console sign-in. */
function siteName(flow: OpenSignInFlow): string {
  return flow.target.kind === "computer" && flow.target.method === "console"
    ? "Anthropic Console"
    : "Claude";
}

/** The page for another device, to copy, and the code it shows, to paste back. */
function OtherDevice({
  flow,
  manualUrl,
  actions,
}: {
  flow: OpenSignInFlow;
  manualUrl: string;
  actions: Actions;
}) {
  const [code, setCode] = useState("");
  return (
    <Stack gap="xs">
      <Surface level="base" className="rounded-md border px-sm py-2xs">
        <Line className="gap-xs">
          <Fill>
            <Text variant="code" tone="muted">
              {manualUrl}
            </Text>
          </Fill>
          <CopyButton text={manualUrl} tooltip="Copy link" />
        </Line>
      </Surface>
      <form
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <Line className="gap-xs">
          <Fill>
            <Input
              autoFocus
              autoComplete="off"
              placeholder="Paste the code from the page"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="font-mono"
            />
          </Fill>
          <Button
            type="submit"
            disabled={!code.trim()}
            onClick={() => actions.submitCode(flow.id, code.trim())}
          >
            Continue
          </Button>
        </Line>
      </form>
    </Stack>
  );
}

function Waiting({
  flow,
  actions,
}: {
  flow: Extract<OpenSignInFlow, { kind: "waiting" }>;
  actions: Actions;
}) {
  const [otherDevice, setOtherDevice] = useState(false);
  const { url, manualUrl } = flow;
  return (
    <Stack gap="sm">
      <Line className="gap-sm">
        <Spinner shape="ring" className="size-3.5 text-primary-text" />
        <Fill>
          <Text variant="body">
            Finish signing in to {siteName(flow)} in your browser
          </Text>
        </Fill>
        <Button variant="ghost" onClick={() => actions.cancel(flow.id)}>
          Cancel
        </Button>
      </Line>
      <Line className="gap-xs">
        {url ? (
          <Button
            variant="link"
            aspect="inline"
            onClick={() => openInBrowserTab(url)}
          >
            Open the page again
          </Button>
        ) : (
          <Text variant="caption" tone="muted">
            Opening the sign-in page…
          </Text>
        )}
        {manualUrl ? (
          <>
            <Text variant="caption" tone="muted">
              ·
            </Text>
            <Button
              variant="link"
              aspect="inline"
              onClick={() => setOtherDevice(!otherDevice)}
            >
              {otherDevice ? "Hide" : "Signing in on another device?"}
            </Button>
          </>
        ) : null}
      </Line>
      {otherDevice && manualUrl ? (
        <OtherDevice flow={flow} manualUrl={manualUrl} actions={actions} />
      ) : null}
    </Stack>
  );
}

function Failed({
  flow,
  actions,
  onRestarted,
}: {
  flow: Extract<OpenSignInFlow, { kind: "failed" }>;
  actions: Actions;
  onRestarted?: (id: string) => void;
}) {
  return (
    <Stack gap="sm">
      <Text variant="body" tone="destructive">
        {flow.error}
      </Text>
      <Line className="gap-xs">
        <Fill />
        <Button variant="ghost" onClick={() => actions.cancel(flow.id)}>
          Close
        </Button>
        <Button
          onClick={async () => {
            const id = await actions.start(flow.target);
            onRestarted?.(id);
          }}
        >
          Try again
        </Button>
      </Line>
    </Stack>
  );
}

/**
 * A sign-in in progress, or the one that failed: finish it in the browser
 * (Open the page again), or on another device (copy its page, paste back the
 * code it shows); Cancel. Failed: Claude Code's words, Close and Try again —
 * a new run, whose id `onRestarted` hands a host that follows one run.
 */
export function ClaudeSignInPanel({
  flow,
  onRestarted,
}: {
  flow: OpenSignInFlow;
  onRestarted?: (id: string) => void;
}) {
  const actions = useClaudeSignInActions();
  return (
    <Surface level="sunken" className="rounded-md p-sm">
      {actions.kind === "unavailable" ? (
        <Text variant="caption" tone="muted">
          {actions.message}
        </Text>
      ) : flow.kind === "waiting" ? (
        <Waiting key={flow.id} flow={flow} actions={actions} />
      ) : (
        <Failed flow={flow} actions={actions} onRestarted={onRestarted} />
      )}
    </Surface>
  );
}
