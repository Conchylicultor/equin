import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { HintCard } from "../../web/components/hint-card";
import { EMPTY_SCENE, type StageBox } from "../../web/components/stage";
import { StageFrame } from "./frame";

const noop = () => {};
/** Where the fake anchor sits in the frame, in px. */
const ANCHOR = { x: 40, y: 32, width: 96, height: 32 };
const BOX: StageBox = {
  rect: { x: 34, y: 26, width: 108, height: 44 },
  radius: 22,
};

/**
 * A tour step over a stand-in app: the scrim dims everything but the ringed
 * cut-out around the anchor, and the coach card sits beside it.
 */
export default function SpotlightExhibit() {
  return (
    <StageFrame
      scene={{
        ...EMPTY_SCENE,
        spot: { mode: "hole", box: BOX },
        card: {
          variant: "step",
          target: BOX,
          placement: "bottom",
          content: (
            <HintCard
              title="Improve anything you see"
              body="Spot a bug, a rough edge, an idea? Click Improve and say it. An agent works on it in the background while you carry on."
              steps={{ count: 6, index: 2 }}
              onClose={noop}
              alt={{ label: "Skip", onClick: noop }}
              onBack={noop}
              primary={{ label: "Try it", onClick: noop }}
            />
          ),
        },
      }}
    >
      <Placed
        x={{ start: ANCHOR.x, size: ANCHOR.width }}
        y={{ start: ANCHOR.y, size: ANCHOR.height }}
      >
        <Button variant="outline" shape="pill" className="size-full">
          Improve
        </Button>
      </Placed>
    </StageFrame>
  );
}
