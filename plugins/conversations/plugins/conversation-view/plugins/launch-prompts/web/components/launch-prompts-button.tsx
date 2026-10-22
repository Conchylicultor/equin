import {
  Button,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ConfigMenuContent } from "@plugins/config_v2/plugins/config-link/web";
import { useState } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { useConfig } from "@plugins/config_v2/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import {
  getEndpointErrorMessage,
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import { createConversation } from "@plugins/conversations/core";
import {
  choiceFamily,
  choiceLabel,
  normalizeModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import { familyClass } from "@plugins/conversations/plugins/model-provider/web";
import { launchPromptsConfig } from "../../shared/config";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const playlistPlayIcon = symbol("playlist-play");

export function LaunchPromptsButton({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const { prompts } = useConfig(launchPromptsConfig);
  const [launching, setLaunching] = useState(false);
  const fetchEndpoint = useFetchEndpoint();
  // Launching needs the computer: on a host without it (the demo) the button
  // is disabled and its tooltip says why.
  const availability = useMachineAvailability(createConversation);
  const toast = useToast();

  if (prompts.length === 0) return null;

  async function launch(item: (typeof prompts)[number]) {
    if (launching) return;
    setLaunching(true);
    try {
      const result = await fetchEndpoint(
        createConversation,
        {},
        {
          body: {
            // item.model is a stored config value (picked from the live catalog
            // but typed as string) — normalize on read to a ModelChoice before
            // it enters the strict createConversation body, whose handler
            // refuses a version the catalog has since retired.
            model: normalizeModelChoice(item.model),
            prompt: item.prompt,
            attemptId: conversation.attemptId,
          },
        },
      );
      if (result.kind === "unavailable") throw new Error(result.message);
      toast({
        type: "conversation",
        title: "Conversation launched",
        description: `Launched: ${item.title}`,
      });
    } catch (err) {
      toast({
        type: "conversation",
        title: "Failed to launch",
        description: getEndpointErrorMessage(err),
        variant: "error",
      });
    } finally {
      setLaunching(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            loading={launching}
            disabled={!availability.available}
            tooltip={availability.available ? undefined : availability.message}
            aria-label="Launch prompts"
          />
        }
      >
        <Icon icon={playlistPlayIcon} className="size-3" />
        Launch
      </DropdownMenuTrigger>
      <ConfigMenuContent
        descriptor={launchPromptsConfig}
        label="Launch prompts"
        align="start"
      >
        {prompts.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onClick={() => void launch(item)}
            className="gap-xl"
          >
            {/* The title is the row's one elastic cell, so the model badge sits
                flush-right without a justify-between on the menu item chrome. */}
            <Fill as="span">{item.title}</Fill>
            {(() => {
              const choice = normalizeModelChoice(item.model);
              return (
                <Badge colorClass={familyClass(choiceFamily(choice))}>
                  {choiceLabel(choice)}
                </Badge>
              );
            })()}
          </DropdownMenuItem>
        ))}
      </ConfigMenuContent>
    </DropdownMenu>
  );
}
