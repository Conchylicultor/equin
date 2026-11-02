import { Icon } from "@plugins/ui/plugins/icons/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Agents as AgentsSlots } from "../slots";
import { systemAgentDetailPane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

const autoAwesomeIcon = symbol("auto-awesome");

export function SystemFolder({
  selectedSystemId,
}: {
  selectedSystemId?: string;
}) {
  const descriptors = AgentsSlots.SystemAgent.useContributions();
  const openPane = useOpenPane();

  if (descriptors.length === 0) return null;

  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="hover:bg-accent gap-xs rounded-md px-xs py-xs text-body">
        <Center as="span" className="size-5">
          <CollapsibleChevron className="size-4" />
        </Center>
        <SectionLabel as="span">System</SectionLabel>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="none">
          {/* eslint-disable-next-line data-view/no-adhoc-row-list -- closed registry of system agents (sidebar nav chrome) */}
          {descriptors.map((d) => {
            const icon = d.icon ?? autoAwesomeIcon;
            const selected = d.id === selectedSystemId;
            return (
              <Row
                key={d.id}
                selected={selected}
                indent={16 + 4}
                icon={<Icon icon={icon} className="text-muted-foreground" />}
                {...openPane.link(
                  systemAgentDetailPane,
                  { systemId: d.id },
                  { mode: "push" },
                )}
              >
                <Text>{d.name}</Text>
              </Row>
            );
          })}
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}
