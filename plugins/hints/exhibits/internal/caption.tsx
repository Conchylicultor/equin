import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { HintCaption } from "../../web/components/hint-card";
import { EMPTY_SCENE, type StageBox } from "../../web/components/stage";
import { StageFrame } from "./frame";

/** Where the fake element sits in the frame, in px. */
const TARGET = { x: 40, y: 32, width: 32, height: 32 };
const BOX: StageBox = {
  id: "pointer",
  rect: { x: 34, y: 26, width: 44, height: 44 },
  radius: 22,
};

/**
 * A Show me highlight (`pointAt`) on an icon-only button: a pulsing ring on
 * the element and its caption beside it — no scrim, nothing to press. (On an
 * element showing its own text, the ring is drawn alone.)
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
        <IconButton
          icon={symbol("share")}
          label="Share"
          variant="outline"
          shape="pill"
          className="size-full"
        />
      </Placed>
    </StageFrame>
  );
}
