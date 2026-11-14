import type { ReactElement } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { supervisorPromptConfig } from "@plugins/tasks/plugins/supervisor-roles/core";
import { useAdhocSupervisors, useRoles } from "../internal/reads";
import { InlineMarkdownField } from "./inline-fields";
import { EventRoutingSection } from "./event-routing-section";

const sharedIcon = symbol("stacks");

/**
 * The pinned "All supervisors" entry: the one prompt every supervisor session
 * is launched with — ad-hoc ones and every role's — ahead of the role's own.
 * The same value as Settings → Config → Supervisors.
 */
export function SharedDetail(): ReactElement {
  const shared = useConfig(supervisorPromptConfig).prompt;
  const setConfig = useSetConfig(supervisorPromptConfig);
  return (
    <Stack gap="xl" className="rail-lg">
      <Stack direction="row" gap="md" align="center">
        <Card padding="sm" className={rigidClass()}>
          <Icon icon={sharedIcon} className="size-5" />
        </Card>
        <Stack gap="none">
          <Text as="h2" variant="title">
            All supervisors
          </Text>
          <Counts />
        </Stack>
      </Stack>
      <Card padding="none">
        <Stack direction="row" gap="lg" align="start" className="p-md">
          <Text
            variant="caption"
            tone="muted"
            className={`w-44 ${rigidClass()}`}
          >
            Shared prompt
          </Text>
          <Fill>
            <InlineMarkdownField
              label="Shared prompt"
              namespace="supervisor-shared-prompt"
              placeholder="What every supervisor session is launched with"
              value={shared}
              onSave={(prompt) => {
                if (!setConfig("prompt", prompt))
                  throw new Error("The shared prompt was not saved.");
              }}
            />
          </Fill>
        </Stack>
      </Card>
      <EventRoutingSection />
    </Stack>
  );
}

function Counts(): ReactElement | null {
  const roles = useRoles();
  const adhoc = useAdhocSupervisors();
  const n = foldResource(roles, {
    loading: () => null,
    error: () => null,
    ready: (r) => r.length,
  });
  const a = foldResource(adhoc, {
    loading: () => null,
    error: () => null,
    ready: (r) => r.length,
  });
  if (n === null || a === null) return null;
  return (
    <Text variant="caption" tone="muted">
      {`${n} supervisors · ${a} ad hoc`}
    </Text>
  );
}
