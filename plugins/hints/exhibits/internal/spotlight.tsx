import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import {
  Button,
  OverlayPanel,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { HintCard } from "../../web/components/hint-card";
import { SpotlightMask } from "../../web/components/spotlight";

const noop = () => {};
/** Where the fake anchor sits in the frame, in px. */
const ANCHOR = { x: 40, y: 32, width: 96, height: 32 };

/**
 * A tour step over a stand-in app: the scrim dims everything but the rounded
 * cut-out around the anchor, and the card floats beneath it. In the app the
 * card is placed by Floating UI; here it is pinned below the anchor.
 */
export default function SpotlightExhibit() {
  return (
    <div className="relative h-96 bg-background">
      <Placed
        x={{ start: ANCHOR.x, size: ANCHOR.width }}
        y={{ start: ANCHOR.y, size: ANCHOR.height }}
      >
        <Button variant="outline" className="size-full">
          Improve
        </Button>
      </Placed>
      <SpotlightMask rect={ANCHOR} />
      <Placed
        x={{ start: ANCHOR.x - 8 }}
        y={{ start: ANCHOR.y + ANCHOR.height + 16 }}
      >
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
      </Placed>
    </div>
  );
}
