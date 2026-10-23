import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { OverlayPanel } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { HintCard } from "../../web/components/hint-card";

const noop = () => {};

/**
 * The hint card as a tour step (dots, ×, Skip, Back, primary) and as a
 * contextual tip (Got it), each in the floating panel it is drawn in.
 */
export default function CardExhibit() {
  return (
    <Stack gap="lg">
      <OverlayPanel width="xl" padding="md" scroll={false}>
        <HintCard
          title="Improve anything"
          body="Describe a change to the app you're looking at. An agent picks it up and builds it."
          steps={{ count: 5, index: 2 }}
          onClose={noop}
          alt={{ label: "Skip", onClick: noop }}
          onBack={noop}
          primary={{ label: "Try it", onClick: noop }}
        />
      </OverlayPanel>
      <OverlayPanel width="xl" padding="md" scroll={false}>
        <HintCard
          title="Try it before it ships"
          body="Open the agent's build of the app and check the change works before you push it."
          onClose={noop}
          primary={{ label: "Got it", onClick: noop }}
        />
      </OverlayPanel>
    </Stack>
  );
}
