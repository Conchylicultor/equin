import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useCallback, type ReactElement } from "react";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { LiveLogChannel } from "@plugins/primitives/plugins/log-channels/web";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  CollapsibleChevron,
} from "@plugins/primitives/plugins/collapsible/web";
import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { BUILD_LOG_CHANNEL } from "@plugins/build/core";
import { getBuildRunLogs } from "../../shared/endpoints";
import type { BuildStepLog } from "../../shared/endpoints";
import { textVariantClass } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const contentCopyIcon = symbol("content-copy");
const checkIcon = symbol("check");
const closeIcon = symbol("close");

// Mono build-log body: intentional fixed code size + line-height (not on the typography scale).
const monoLogClass = textVariantClass("code");

export function BuildLogSection({ runId }: { runId: string }): ReactElement {
  const { data } = useEndpoint(getBuildRunLogs, { id: runId });

  const hasPersistedLogs = data && data.steps.length > 0;

  if (hasPersistedLogs) {
    return <PersistedLogs steps={data.steps} />;
  }

  return <LiveLogs />;
}

function PersistedLogs({ steps }: { steps: BuildStepLog[] }): ReactElement {
  const toast = useToast();
  const copyAll = useCallback(async () => {
    const text = steps
      .map((s) => {
        const header = `── ${s.label} ${s.success ? "✓" : "✗"} (${(s.durationMs / 1000).toFixed(1)}s)`;
        const body = s.lines.map((l) => `  ${l.text}`).join("\n");
        return body ? `${header}\n${body}` : header;
      })
      .join("\n\n");
    await navigator.clipboard.writeText(text);
    toast({
      type: "build",
      title: "Logs copied",
      description: "Build logs copied to clipboard",
      variant: "info",
    });
  }, [steps, toast]);

  return (
    <Stack gap="xs">
      <Stack
        direction="row"
        gap="sm"
        align="center"
        justify="between"
        className="pb-xs"
      >
        <Text as="span" variant="label" className="text-muted-foreground">
          Logs
        </Text>
        <ControlSizeProvider size="xs">
          <IconButton
            icon={contentCopyIcon}
            label="Copy logs"
            variant="ghost"
            onClick={copyAll}
          />
        </ControlSizeProvider>
      </Stack>
      {steps.map((step) => (
        <StepSection key={step.id} step={step} />
      ))}
    </Stack>
  );
}

function StepSection({ step }: { step: BuildStepLog }): ReactElement {
  const duration = (step.durationMs / 1000).toFixed(1);

  return (
    <Collapsible defaultOpen={!step.success || step.lines.length <= 6}>
      <Clip className="rounded-md border bg-muted/30">
        {/* CollapsibleTrigger is already a line container (`flex w-full region-line`),
            so this only adds the gap + chrome. */}
        <CollapsibleTrigger className="gap-sm px-md py-xs text-caption hover:bg-muted/50 transition-colors">
          <CollapsibleChevron className="size-3 text-muted-foreground" />
          {step.success ? (
            <Icon
              icon={checkIcon}
              className={cn("size-3.5 text-success", rigidClass())}
            />
          ) : (
            <Icon
              icon={closeIcon}
              className={cn("size-3.5 text-destructive", rigidClass())}
            />
          )}
          <span className="font-medium">{step.label}</span>
          <span className="text-muted-foreground ml-auto">{duration}s</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {step.lines.length > 0 && (
            <Scroll
              axis="y"
              className={`border-t px-md py-sm max-h-64 ${monoLogClass}`}
            >
              {step.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre-wrap break-all",
                    line.stream === "stderr"
                      ? "text-destructive"
                      : "text-foreground",
                  )}
                >
                  {line.text}
                </div>
              ))}
            </Scroll>
          )}
        </CollapsibleContent>
      </Clip>
    </Collapsible>
  );
}

/**
 * The live tail, for a run whose per-step logs are not on disk yet (a build
 * still in flight, or one whose artifact never landed). Body, socket, de-dup and
 * copy button all belong to the shared `LiveLogChannel` primitive — this file
 * used to carry its own copy of them.
 */
function LiveLogs(): ReactElement {
  const toast = useToast();
  return (
    <LiveLogChannel
      channel={BUILD_LOG_CHANNEL}
      label="Logs"
      emptyState="No build logs yet"
      onError={(error) =>
        toast({
          type: "build",
          title: "Build log error",
          description: error,
          variant: "error",
        })
      }
    />
  );
}
