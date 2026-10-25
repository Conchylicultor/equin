import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { HintCaption } from "../../web/components/hint-card";
import { EMPTY_SCENE, type StageBox } from "../../web/components/stage";
import { StageFrame } from "./frame";

/** Where the fake element sits in the frame, in px. */
const TARGET = { x: 40, y: 32, width: 96, height: 32 };
const BOX: StageBox = {
  id: "pointer",
  rect: { x: 34, y: 26, width: 108, height: 44 },
  radius: 22,
};

/**
 * A Show me highlight (`pointAt`): a pulsing ring on the element and its
 * caption beside it — no scrim, nothing to press.
 */
export default function CaptionExhibit() {
  return (
    <StageFrame
      scene={{
        ...EMPTY_SCENE,
        halos: [BOX],
        card: {
          variant: "caption",
          target: BOX,
          placement: "bottom",
          content: <HintCaption body="The Share button" />,
        },
      }}
    >
      <Placed
        x={{ start: TARGET.x, size: TARGET.width }}
        y={{ start: TARGET.y, size: TARGET.height }}
      >
        <Button variant="outline" shape="pill" className="size-full">
          Share
        </Button>
      </Placed>
    </StageFrame>
  );
}
