import { HintCard } from "../../web/components/hint-card";
import { EMPTY_SCENE } from "../../web/components/stage";
import { StageFrame } from "./frame";

const noop = () => {};

/**
 * A `pointAt` caption (Show me): no title, so the body shares the first row
 * with the × — no empty row above it.
 */
export default function CaptionExhibit() {
  return (
    <StageFrame
      scene={{
        ...EMPTY_SCENE,
        card: {
          variant: "step",
          target: null,
          placement: "bottom",
          content: (
            <HintCard
              body="The Share button — it copies a link to this page."
              onClose={noop}
              closeLabel="Close (Esc)"
              primary={{ label: "Done", onClick: noop }}
            />
          ),
        },
      }}
    />
  );
}
