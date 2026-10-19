import { useState } from "react";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { groupThread, threadStateOf } from "../../core";
import { AgentThreadView } from "../../web/components/agent-thread-view";
import { ThreadComposerView } from "../../web/components/composer";
import { showPicks, type ThreadFixture } from "./fixtures";

/**
 * The thread over a fixture transcript, through the real `groupThread` and
 * `AgentThreadView`. The live parts are inert here: the composer types but
 * sends nothing, Open conversation goes nowhere, and a pending question shows
 * no answer form (that card reads the conversation's held question live).
 */
export function ThreadExhibit({ fixture }: { fixture: ThreadFixture }) {
  const [draft, setDraft] = useState("");
  const turns = groupThread(fixture.events, [showPicks], fixture.conversation);
  const working =
    fixture.conversation.status === "working" ||
    fixture.conversation.status === "starting";
  return (
    // A host's panel: the thread fills it.
    <div className="h-[36rem]">
      <AgentThreadView
        turns={turns}
        state={threadStateOf(turns, fixture.conversation)}
        renderResult={(result, { latest }) => (
          <Stack gap="xs">
            {result.payload.picks.map((pick) => (
              <Card key={pick.googlePlaceId}>
                <Stack gap="2xs">
                  <Text
                    variant="label"
                    className={latest ? undefined : "line-through"}
                  >
                    {pick.name}
                  </Text>
                  {latest && (
                    <Text variant="caption" tone="muted">
                      {pick.why}
                    </Text>
                  )}
                </Stack>
              </Card>
            ))}
          </Stack>
        )}
        headerAction={<Button variant="ghost">Open conversation</Button>}
        composer={
          <ThreadComposerView
            value={draft}
            onChange={setDraft}
            onSubmit={() => setDraft("")}
            placeholder="Reply to Sonnet — e.g. cheaper, open late"
            disabled={false}
            onStop={working ? () => undefined : undefined}
            namespace="agent-thread-exhibit"
          />
        }
      />
    </div>
  );
}
