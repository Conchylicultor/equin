import { HintCard } from "../../web/components/hint-card";
import { EMPTY_SCENE } from "../../web/components/stage";
import { StageFrame } from "./frame";

const noop = () => {};

/** The coach card as a contextual tip (Got it), centered in its frame. */
export default function CardExhibit() {
  return (
    <StageFrame
      scene={{
        ...EMPTY_SCENE,
        card: {
          variant: "tip",
          target: null,
          placement: "bottom",
          content: (
            <HintCard
              title="Try it before it ships"
              body="The agent built this on its own copy of equin. Open it to try the change for real — nothing reaches your equin until you push."
              primary={{ label: "Got it", onClick: noop }}
            />
          ),
        },
      }}
    />
  );
}
